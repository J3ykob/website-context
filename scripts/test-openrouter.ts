import { OpenRouterProvider } from "../src/llm/openrouter-provider.js";

const p = new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY });
const r = await p.chat([
  { role: "system", content: "Reply with just: working" },
  { role: "user", content: "test" },
]);
console.log("Response:", r.content);
console.log("Usage:", JSON.stringify(r.usage));
