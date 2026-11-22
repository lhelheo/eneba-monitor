const ts = () => new Date().toLocaleString("pt-BR", { hour12: false });

export const log = {
  info: (msg: string) => console.log(`[${ts()}] ${msg}`),
  warn: (msg: string) => console.warn(`[${ts()}] ⚠ ${msg}`),
  error: (msg: string) => console.error(`[${ts()}] ✖ ${msg}`),
};
