const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_AI_TIMEOUT = 180000;

function compact(value, max = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('AI response is empty');
  try {
    return JSON.parse(value);
  } catch {}

  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`AI response is not JSON: ${compact(value, 300)}`);
  return JSON.parse(match[0]);
}

function buildSystemPrompt() {
  return `You control a browser capture tool. Return only one JSON object.

Allowed modes:
- execute: perform one safe browser action.
- ask_user: ask the human to complete one step.
- finish: capture goal is complete.

Allowed execute actions:
- fill: requires targetRef and valueFrom "aiInput" or value.
- click: requires targetRef.
- press: requires key, targetRef optional.
- wait: optional targetRef, waits for visible element or page settle.

Rules:
- Never output JavaScript or Playwright code.
- Select targets by idRef from the provided elements.
- Always include confidence as a number between 0 and 1.
- Do not operate login, password, captcha, payment, purchase, delete, account, or authorization controls.
- If targets are ambiguous, risky, hidden, disabled, or missing, use ask_user.
- Use finish only when the requested result/output is visible or the goal is clearly complete.
- Keep userInstruction short and actionable when asking the user.`;
}

function buildUserPrompt(observation) {
  return JSON.stringify(observation, null, 2);
}

function providerType(options = {}) {
  return options.providerType || options.provider || process.env.WEBADAPTERTOOLS_AI_PROVIDER || 'raw';
}

export function resolveAiTimeout(options = {}) {
  const value = options.timeout ?? options.aiTimeout ?? process.env.WEBADAPTERTOOLS_AI_TIMEOUT;
  const numeric = Number(value || DEFAULT_AI_TIMEOUT);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_AI_TIMEOUT;
  return numeric;
}

async function withTimeout(task, timeout, label) {
  let timer = null;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map(part => typeof part === 'string' ? part : part?.text || '').join('\n');
  }
  return String(message?.content || '');
}

async function createLangGraphAiProvider(options = {}) {
  let langgraph;
  let openai;
  try {
    [langgraph, openai] = await Promise.all([
      import('@langchain/langgraph'),
      import('@langchain/openai')
    ]);
  } catch (error) {
    throw new Error(`LangGraph AI provider requires optional dependencies. Run "pnpm add @langchain/langgraph @langchain/core @langchain/openai". Original error: ${error.message}`);
  }

  const baseUrl = options.baseUrl || process.env.WEBADAPTERTOOLS_AI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = options.apiKey || process.env.WEBADAPTERTOOLS_AI_API_KEY || process.env.OPENAI_API_KEY || '';
  const model = options.model || process.env.WEBADAPTERTOOLS_AI_MODEL || 'gpt-5.4-mini';
  const timeout = resolveAiTimeout(options);
  if (!apiKey) {
    throw new Error('Missing AI API key. Set WEBADAPTERTOOLS_AI_API_KEY or OPENAI_API_KEY, or use --ai-mode assist.');
  }

  const llm = new openai.ChatOpenAI({
    model,
    temperature: 0,
    apiKey,
    openAIApiKey: apiKey,
    timeout,
    configuration: {
      baseURL: baseUrl
    },
    modelKwargs: {
      response_format: { type: 'json_object' }
    }
  });

  function createState() {
    if (langgraph.StateSchema && langgraph.MessagesValue) {
      return new langgraph.StateSchema({
        messages: langgraph.MessagesValue
      });
    }
    if (langgraph.Annotation?.Root) {
      return langgraph.Annotation.Root({
        messages: langgraph.Annotation({
          reducer: (left, right) => [...(left || []), ...(Array.isArray(right) ? right : [right])],
          default: () => []
        })
      });
    }
    throw new Error('Unsupported @langchain/langgraph version: missing StateSchema or Annotation.Root');
  }

  const State = createState();
  const graph = new langgraph.StateGraph(State)
    .addNode('decide_action', async (state, config) => {
      const response = await llm.invoke(state.messages, {
        ...config,
        runName: 'wat_ai_decision_model',
        tags: ['web-adapter-tools', 'ai-capture', 'decision-model']
      });
      return { messages: [response] };
    })
    .addEdge(langgraph.START, 'decide_action')
    .addEdge('decide_action', langgraph.END)
    .compile();

  return {
    type: 'langgraph',
    timeout,
    async decide(observation) {
      const messages = [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(observation) }
      ];
      const output = await withTimeout(graph.invoke({ messages }, {
        runName: 'wat_ai_capture_decision_graph',
        tags: ['web-adapter-tools', 'ai-capture', observation.mode || 'hybrid'],
        metadata: {
          goal: compact(observation.goal, 500),
          stepIndex: observation.stepIndex,
          pageTitle: observation.page?.title || '',
          pageUrl: observation.page?.url || '',
          timeoutMs: timeout
        }
      }), timeout, 'LangGraph AI decision');
      const lastMessage = output?.messages?.[output.messages.length - 1];
      return extractJsonObject(messageContent(lastMessage));
    }
  };
}

function createRawAiProvider(options = {}) {
  const baseUrl = options.baseUrl || process.env.WEBADAPTERTOOLS_AI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = options.apiKey || process.env.WEBADAPTERTOOLS_AI_API_KEY || process.env.OPENAI_API_KEY || '';
  const model = options.model || process.env.WEBADAPTERTOOLS_AI_MODEL || 'gpt-5.4-mini';
  const timeout = resolveAiTimeout(options);

  return {
    type: 'raw',
    timeout,
    async decide(observation) {
      if (!apiKey) {
        throw new Error('Missing AI API key. Set WEBADAPTERTOOLS_AI_API_KEY or OPENAI_API_KEY, or use --ai-mode assist.');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let response;
      try {
        response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: buildSystemPrompt() },
              { role: 'user', content: buildUserPrompt(observation) }
            ]
          })
        });
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error(`AI request timed out after ${timeout}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`AI request failed (${response.status}): ${compact(body, 500)}`);
      }

      const data = await response.json();
      return extractJsonObject(data?.choices?.[0]?.message?.content);
    }
  };
}

export function createAiProvider(options = {}) {
  const type = providerType(options);
  if (type === 'langgraph') return createLangGraphAiProvider(options);
  if (type !== 'raw') {
    throw new Error(`Unsupported AI provider: ${type}. Use raw or langgraph.`);
  }
  return createRawAiProvider(options);
}

function normalizeConfidence(value, decision, mode) {
  if (value !== undefined && value !== null && value !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (numeric > 1 && numeric <= 100) return Math.max(0, Math.min(1, numeric / 100));
      return Math.max(0, Math.min(1, numeric));
    }
  }

  if (mode === 'ask_user') return 1;
  if (mode === 'finish') return 0.8;

  const action = decision.action || null;
  const targetRef = decision.targetRef || decision.target?.idRef || null;
  const hasRequiredTarget = !['fill', 'click'].includes(action) || Boolean(targetRef);
  const isKnownAction = ['fill', 'click', 'press', 'wait'].includes(action);
  return isKnownAction && hasRequiredTarget ? 0.8 : 0;
}

export function normalizeAiDecision(raw) {
  const decision = raw && typeof raw === 'object' ? raw : {};
  const mode = decision.mode || (decision.action === 'finish' ? 'finish' : 'execute');
  const confidence = normalizeConfidence(decision.confidence, decision, mode);
  return {
    mode,
    confidence,
    confidenceSource: decision.confidence === undefined ? 'implicit' : 'model',
    action: decision.action || null,
    targetRef: decision.targetRef || decision.target?.idRef || null,
    value: decision.value ?? '',
    valueFrom: decision.valueFrom || null,
    key: decision.key || null,
    waitAfter: decision.waitAfter || null,
    userInstruction: decision.userInstruction || '',
    reason: decision.reason || ''
  };
}
