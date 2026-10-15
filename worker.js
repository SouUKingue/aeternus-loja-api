
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Plugin-Key",
  "Content-Type": "application/json; charset=utf-8"
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors
  });
}

function validNick(nick) {
  return typeof nick === "string" &&
    /^[A-Za-z0-9_]{3,16}$/.test(nick);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (method === "GET" && path === "/api/health") {
        await env.DB.prepare("SELECT 1").first();
        return reply({ ok: true, database: "connected" });
      }

      if (method === "POST" && path === "/api/link/start") {
        const body = await readBody(request);
        if (!body || !validNick(body.nick)) {
          return reply({ error: "Nick inválido." }, 400);
        }

        const nick = body.nick;
        const code = crypto.randomUUID()
          .replace(/-/g, "")
          .slice(0, 8)
          .toUpperCase();

        await env.DB.prepare(`
          INSERT INTO accounts
            (minecraft_nick, verification_code, verified)
          VALUES (?, ?, 0)
          ON CONFLICT(minecraft_nick) DO UPDATE SET
            verification_code = excluded.verification_code
          WHERE accounts.verified = 0
        `).bind(nick, code).run();

        const account = await env.DB.prepare(`
          SELECT verified FROM accounts WHERE minecraft_nick = ?
        `).bind(nick).first();

        if (account?.verified === 1) {
          return reply({ error: "Esta conta já está vinculada." }, 409);
        }

        return reply({
          ok: true,
          nick,
          code,
          message: "Entre no servidor e confirme o código."
        });
      }

      if (method === "GET" && path === "/api/link/status") {
        const nick = url.searchParams.get("nick");

        if (!validNick(nick)) {
          return reply({ error: "Nick inválido." }, 400);
        }

        const account = await env.DB.prepare(`
          SELECT verified FROM accounts WHERE minecraft_nick = ?
        `).bind(nick).first();

        if (!account) {
          return reply({ linked: false, exists: false });
        }

        return reply({
          exists: true,
          linked: account.verified === 1
        });
      }

      if (method === "POST" && path === "/api/link/confirm") {
        if (!env.PLUGIN_API_KEY ||
            request.headers.get("X-Plugin-Key") !== env.PLUGIN_API_KEY) {
          return reply({ error: "Não autorizado." }, 401);
        }

        const body = await readBody(request);
        if (!body || !validNick(body.nick) ||
            typeof body.code !== "string") {
          return reply({ error: "Dados inválidos." }, 400);
        }

        const result = await env.DB.prepare(`
          UPDATE accounts
          SET verified = 1, verification_code = NULL
          WHERE minecraft_nick = ?
            AND verification_code = ?
            AND verified = 0
        `).bind(body.nick, body.code.toUpperCase()).run();

        if (!result.meta.changes) {
          return reply({
            error: "Código inválido, expirado ou já utilizado."
          }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO fragments (minecraft_nick, balance)
          VALUES (?, 0)
          ON CONFLICT(minecraft_nick) DO NOTHING
        `).bind(body.nick).run();

        return reply({ ok: true, linked: true });
      }

      if (method === "POST" && path === "/api/bonus/claim") {
        const body = await readBody(request);
        if (!body || !validNick(body.nick)) {
          return reply({ error: "Nick inválido." }, 400);
        }

        const nick = body.nick;
        const account = await env.DB.prepare(`
          SELECT verified FROM accounts WHERE minecraft_nick = ?
        `).bind(nick).first();

        if (!account || account.verified !== 1) {
          return reply({
            error: "Vincule e confirme sua conta no servidor primeiro."
          }, 403);
        }

        const claim = await env.DB.prepare(`
          INSERT INTO bonus_claims (minecraft_nick, bonus_type)
          VALUES (?, 'site_50')
          ON CONFLICT(minecraft_nick, bonus_type) DO NOTHING
        `).bind(nick).run();

        if (!claim.meta.changes) {
          return reply({ error: "Você já recebeu o bônus." }, 409);
        }

        await env.DB.batch([
          env.DB.prepare(`
            UPDATE fragments
            SET balance = balance + 50
            WHERE minecraft_nick = ?
          `).bind(nick),
          env.DB.prepare(`
            INSERT INTO fragment_transactions
              (minecraft_nick, amount, reason)
            VALUES (?, 50, 'Bônus do site')
          `).bind(nick)
        ]);

        const balance = await env.DB.prepare(`
          SELECT balance FROM fragments WHERE minecraft_nick = ?
        `).bind(nick).first();

        return reply({
          ok: true,
          awarded: 50,
          balance: balance?.balance ?? 0
        });
      }

      return reply({ error: "Rota não encontrada." }, 404);
    } catch (error) {
      return reply({ error: "Erro interno da API." }, 500);
    }
  }
};

