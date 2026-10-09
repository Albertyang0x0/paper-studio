export const testBase = process.env.PAPER_TEST_BASE_URL ?? 'http://localhost:8788';

export async function requireTestServer() {
  const response = await fetch(testBase + '/api/status');
  const status = await response.json() as { dataScope?: string };
  if (!response.ok || status.dataScope !== 'test') {
    throw Error('Refusing to write test results to a live server; use an isolated test instance.');
  }
}
