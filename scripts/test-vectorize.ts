import { VectorizeStore } from "../src/embeddings/vectorize-store.js";

async function test() {
  const store = new VectorizeStore({ namespace: "test_tenant_123" });
  const otherStore = new VectorizeStore({ namespace: "other_tenant" });
  const vec = Array.from({length: 1024}, (_, i) => Math.sin(i));
  const vec2 = Array.from({length: 1024}, (_, i) => Math.cos(i));

  console.log("Inserting vectors for two tenants...");
  await store.upsert([
    { id: "doc1", content: "Hotels in Amsterdam", metadata: { title: "Hotels" }, vector: vec },
  ]);
  await otherStore.upsert([
    { id: "doc2", content: "Restaurants in Paris", metadata: { title: "Restaurants" }, vector: vec2 },
  ]);

  console.log("Waiting for indexing...");
  await new Promise(r => setTimeout(r, 5000));

  console.log("Query tenant 1 (should find Hotels):");
  const r1 = await store.search(vec, 5);
  console.log(`  Results: ${r1.length}`);
  r1.forEach(r => console.log(`  ${r.content} (score: ${r.score})`));

  console.log("Query tenant 2 (should find Restaurants):");
  const r2 = await otherStore.search(vec2, 5);
  console.log(`  Results: ${r2.length}`);
  r2.forEach(r => console.log(`  ${r.content} (score: ${r.score})`));

  console.log("Query tenant 1 with wrong vector (should still find Hotels but lower score):");
  const r3 = await store.search(vec2, 5);
  console.log(`  Results: ${r3.length}`);
  r3.forEach(r => console.log(`  ${r.content} (score: ${r.score})`));

  // Cleanup
  await store.deleteNamespace();
  await otherStore.deleteNamespace();
  console.log("Done");
}
test().catch(console.error);
