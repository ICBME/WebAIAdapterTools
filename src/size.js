export const DEFAULT_WINDOW_SIZE = {
  width: 1000,
  height: 620
};

export function parseWindowSize(value) {
  if (value == null || value === '') return { ...DEFAULT_WINDOW_SIZE };

  const match = String(value).trim().match(/^(\d{3,5})x(\d{3,5})$/i);
  if (!match) {
    throw new Error('--window-size must use WIDTHxHEIGHT format, for example 1280x720');
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || height < 480) {
    throw new Error('--window-size must be at least 640x480');
  }

  return { width, height };
}
