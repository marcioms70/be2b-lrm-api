/** Envio de e-mail via Resend (REST). Sem dependências; `fetch` injetável para teste. */
export class EmailError extends Error {
  constructor(message, { status = null } = {}) { super(message); this.name = "EmailError"; this.status = status; }
}

export function emailConfig(env = process.env) {
  const apiKey = env.RESEND_API_KEY || "";
  const from = env.REPORT_FROM_EMAIL || "";
  return { apiKey, from, enabled: Boolean(apiKey && from) };
}

/**
 * @param {{ to: string[], subject: string, html: string, text: string }} msg
 * @returns {Promise<{ id: string|null }>}
 */
export async function sendEmail(msg, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = emailConfig(env);
  if (!cfg.enabled) throw new EmailError("Envio de e-mail não configurado (RESEND_API_KEY e REPORT_FROM_EMAIL).");
  if (!msg.to?.length) throw new EmailError("Sem destinatários.");

  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
    });
  } catch (err) {
    throw new EmailError(`Falha de rede ao enviar e-mail: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new EmailError(body?.message || `O provedor de e-mail recusou o envio (HTTP ${res.status}).`, { status: res.status });
  return { id: body?.id ?? null };
}
