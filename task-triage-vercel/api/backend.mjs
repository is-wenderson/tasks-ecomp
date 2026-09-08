/**
 * Vercel Function — proxy para o Google Apps Script.
 *
 * Você só precisa colar a URL /exec do seu Apps Script abaixo.
 * Não é necessário configurar variáveis de ambiente no Vercel.
 */

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyT2VhOZbhrIEwLdacmlbWY8QpIVG3R7zJLh1uYXlSveio6LMZCAPTmm9UuLgdr0FNE/exec";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function validAppsScriptUrl(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/i.test(url);
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return json({ ok: true, service: "task-triage-vercel-proxy" });
    }

    if (request.method !== "POST") {
      return json(
        { ok: false, code: "METHOD_NOT_ALLOWED", error: "Método não permitido." },
        405
      );
    }

    if (!validAppsScriptUrl(APPS_SCRIPT_URL)) {
      return json(
        {
          ok: false,
          code: "BACKEND_NOT_CONFIGURED",
          error: "A URL do Google Apps Script não está configurada corretamente.",
        },
        500
      );
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(
        { ok: false, code: "INVALID_JSON", error: "Corpo JSON inválido." },
        400
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json(
        { ok: false, code: "INVALID_PAYLOAD", error: "Requisição inválida." },
        400
      );
    }

    // O front-end antigo pode enviar sitePassword. Não precisamos dele nesta versão.
    delete payload.sitePassword;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150000);

    try {
      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify(payload),
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });

      const raw = await upstream.text();
      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        return json(
          {
            ok: false,
            code: "INVALID_UPSTREAM_RESPONSE",
            error: "O Google Apps Script não retornou JSON válido. Confira a implantação do Web App.",
          },
          502
        );
      }

      if (!upstream.ok) {
        return json(
          {
            ok: false,
            code: "UPSTREAM_HTTP_ERROR",
            error:
              data?.error ||
              `Google Apps Script respondeu com status ${upstream.status}.`,
          },
          502
        );
      }

      return json(data, 200);
    } catch (error) {
      if (error && error.name === "AbortError") {
        return json(
          {
            ok: false,
            code: "UPSTREAM_TIMEOUT",
            error: "O backend demorou além do limite para responder.",
          },
          504
        );
      }

      return json(
        {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          error: "Não foi possível conectar ao Google Apps Script.",
        },
        502
      );
    } finally {
      clearTimeout(timer);
    }
  },
};
