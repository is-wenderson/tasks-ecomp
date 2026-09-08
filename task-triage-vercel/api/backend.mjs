/**
 * Vercel Function — proxy seguro para o Google Apps Script.
 *
 * Variáveis de ambiente no Vercel:
 *   APPS_SCRIPT_URL         = URL /exec do Web App do Apps Script
 *   APPS_SCRIPT_ACCESS_KEY  = mesmo valor de APP_ACCESS_KEY no Apps Script
 *   SITE_PASSWORD           = opcional; senha para abrir/usar o app publicado
 */

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

function config() {
  return {
    appsScriptUrl: String(process.env.APPS_SCRIPT_URL || "").trim(),
    appsScriptAccessKey: String(process.env.APPS_SCRIPT_ACCESS_KEY || ""),
    sitePassword: String(process.env.SITE_PASSWORD || ""),
  };
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
      return json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "Método não permitido." }, 405);
    }

    const { appsScriptUrl, appsScriptAccessKey, sitePassword } = config();

    if (!validAppsScriptUrl(appsScriptUrl)) {
      return json({
        ok: false,
        code: "BACKEND_NOT_CONFIGURED",
        error: "APPS_SCRIPT_URL não está configurada corretamente no Vercel. Use a URL de implantação que termina em /exec.",
      }, 500);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, code: "INVALID_JSON", error: "Corpo JSON inválido." }, 400);
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ ok: false, code: "INVALID_PAYLOAD", error: "Requisição inválida." }, 400);
    }

    const suppliedSitePassword = String(payload.sitePassword || "");
    delete payload.sitePassword;

    if (sitePassword && suppliedSitePassword !== sitePassword) {
      return json({
        ok: false,
        code: "ACCESS_REQUIRED",
        error: "Senha de acesso inválida ou não informada.",
      }, 401);
    }

    // Esta chave nunca chega ao navegador. Ela existe apenas no ambiente Vercel
    // e deve ser igual à propriedade APP_ACCESS_KEY do Apps Script.
    payload.accessKey = appsScriptAccessKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150000);

    try {
      const upstream = await fetch(appsScriptUrl, {
        method: "POST",
        headers: {
          // text/plain evita preflight desnecessário no Apps Script e é suficiente
          // porque o Code.gs lê e faz JSON.parse de e.postData.contents.
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
        return json({
          ok: false,
          code: "INVALID_UPSTREAM_RESPONSE",
          error: "O Google Apps Script não retornou JSON válido. Confira a implantação do Web App.",
        }, 502);
      }

      if (!upstream.ok) {
        return json({
          ok: false,
          code: "UPSTREAM_HTTP_ERROR",
          error: data?.error || `Google Apps Script respondeu com status ${upstream.status}.`,
        }, 502);
      }

      // Erros de regra de negócio do Apps Script continuam como JSON normal;
      // o front-end já trata data.ok === false e mostra a mensagem correta.
      return json(data, 200);
    } catch (error) {
      if (error && error.name === "AbortError") {
        return json({
          ok: false,
          code: "UPSTREAM_TIMEOUT",
          error: "O backend demorou além do limite para responder.",
        }, 504);
      }

      return json({
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        error: "Não foi possível conectar ao Google Apps Script.",
      }, 502);
    } finally {
      clearTimeout(timer);
    }
  },
};
