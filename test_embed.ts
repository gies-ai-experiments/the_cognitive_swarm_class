import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: "AIzaSyAqX5a9lvo58lz_Ihh9fkKF95d8c6Ebpcg" });
async function run() {
  try {
    const res = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: "hello"
    });
    console.log("text-embedding-004", res.embeddings?.[0]?.values?.length);
  } catch (e) {
    console.error("text-embedding-004 error", e);
  }
}
run();
