// Never include request URLs (which may contain interaction tokens) in errors.
export async function discordApi(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://discord.com/api/v10/${path}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(`Discord request failed: HTTP ${response.status}, code ${payload.code ?? 'unknown'}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}
