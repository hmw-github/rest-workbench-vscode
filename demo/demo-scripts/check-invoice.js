// Response handler used by demo.http (request 9) - JetBrains HTTP Client API:
// client.test / client.assert / client.global, response.status / body / headers
client.test("invoice found", () => client.assert(response.status === 200, `status ${response.status}`));

client.test("amount matches the created invoice", () => {
  const expected = client.global.get("invoiceAmount");
  client.assert(String(response.body.amount) === expected, `expected ${expected}, got ${response.body.amount}`);
});

client.test("new invoices are pending", () => client.assert(response.body.status === "pending"));
