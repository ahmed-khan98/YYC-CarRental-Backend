/** Thin wrapper so PM2 still sees the same console output. */
export const logger = {
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  info: (...args) => console.log(...args),
};
