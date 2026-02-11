require("dotenv").config();

const { Resend } = require("resend");
const { Client } = require("@notionhq/client");
const OpenAI = require("openai");
const express = require("express");
const cookieParser = require("cookie-parser");

const notion = new Client({
  auth: process.env.NOTION_API_KEY
});
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

app.use(express.static("public"));
app.use(express.json());
app.use(cookieParser());

app.post("/message", async (req, res) => {
const userEmail = req.cookies.user_email;

if (!userEmail) {
  return res.status(401).json({
    error: "Utilisateur non connecté"
  });
}
  const userMessage = req.body.message;
  console.log("Message reçu :", userMessage);

const intentCheck = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    {
      role: "system",
      content: `
Tu dois répondre uniquement par "QUESTION" ou "NOTE".

QUESTION = l’utilisateur cherche une information déjà notée.
NOTE = l’utilisateur dépose une nouvelle information.
`
    },
    {
      role: "user",
      content: userMessage
    }
  ]
});

const rawIntent = intentCheck.choices[0].message.content;

const intent = rawIntent
  .toUpperCase()
  .includes("QUESTION")
  ? "QUESTION"
  : "NOTE";

// 🧠 CAS 1 : l’utilisateur pose une QUESTION → on cherche dans sa mémoire
if (intent === "QUESTION") {

  let allResults = [];
  let hasMore = true;
  let cursor = undefined;

  // 🔁 récupérer TOUTES les notes de l’utilisateur (pagination complète)
  while (hasMore) {
    const response = await fetch(
      "https://api.notion.com/v1/databases/2f21c666d48380a69289dfb9e10de8c4/query",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filter: {
            property: "utilisateur",
            email: {
              equals: userEmail
            }
          },
          start_cursor: cursor,
          page_size: 100
        })
      }
    );

    const data = await response.json();

    allResults = allResults.concat(data.results);
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }

  // 🧩 construire le contexte mémoire lisible
  const memoryContext = allResults
    .map(page => {
      const title =
        page.properties["Titre"]?.title?.[0]?.plain_text || "";
      const content =
        page.properties["Contenu brut"]?.rich_text?.[0]?.plain_text || "";

      if (!title && !content) return null;

      return `• ${title} — ${content}`;
    })
    .filter(Boolean)
    .join("\n");

  // 🧠 demander à l’IA de répondre UNIQUEMENT à partir de la mémoire
  const answerCompletion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Tu es une mémoire personnelle calme et fiable.

Voici des notes précédentes de l’utilisateur :
${memoryContext || "Aucune note disponible."}

Règles :
- Réponds uniquement avec les informations présentes ci-dessus.
- N’invente rien.
- Si l’information n’est pas trouvable, dis-le simplement.
`
      },
      {
        role: "user",
        content: userMessage
      }
    ]
  });

  const answer =
    answerCompletion.choices[0].message.content.trim();

  // ✅ on répond et on SORT — aucune création de note
  return res.json({
    reply: answer
  });
}

const userTimezone = process.env.USER_TIMEZONE || "America/Toronto";

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: userTimezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
})
  .format(new Date())
  .replace(/\//g, "-");

  // 1. Appel IA → réponse structurée
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Nous sommes le ${today}.
Le fuseau horaire de l’utilisateur est ${userTimezone}.
Toutes les dates et heures doivent être interprétées dans ce fuseau.

Tu es une mémoire externe calme et fiable.

Tu dois TOUJOURS créer une entrée dans une base Notion appelée Inbox.

Champs disponibles :
- titre
- contenu brut
- date de rappel (optionnelle)

Règles :
- Ne pose jamais de question.
- Fais une hypothèse raisonnable si une date est floue.
- Si aucune date n’est détectable, mets null.
- Le contenu brut doit contenir la phrase originale.

Réponds STRICTEMENT en JSON valide, selon ce format :

{
  "titre": "...",
  "contenu": "...",
  "date_rappel": null | "YYYY-MM-DDTHH:MM"
}
`
      },
      {
        role: "user",
        content: userMessage
      }
    ]
  });

  const aiResponse = JSON.parse(
    completion.choices[0].message.content
  );

  // 2. Écriture dans Notion
  await notion.pages.create({
    parent: { database_id: "2f21c666d48380a69289dfb9e10de8c4" },
    properties: {
      "Titre": {
        title: [
          {
            text: { content: aiResponse.titre }
          }
        ]
      },
      "Contenu brut": {
        rich_text: [
          {
            text: { content: aiResponse.contenu }
          }
        ]
      },
      "Date de rappel": aiResponse.date_rappel
        ? {
            date: { start: aiResponse.date_rappel }
          }
        : undefined,
"utilisateur": {
  email: userEmail
}
    }
  });

  // 3. Réponse utilisateur (simple, calme)
  res.json({
    reply: "C’est noté. Je m’en souviens pour toi."
  });
});

app.post("/login", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email manquant" });
  }

  const token = Math.random().toString(36).substring(2, 15);

  // expiration : maintenant + 10 minutes (UTC ISO)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
  const notionResponse = await fetch(
    "https://api.notion.com/v1/pages",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        parent: {
          database_id: "2fc1c666d4838033810dec41019b6ce9"
        },
        properties: {
          email: {
            title: [{ text: { content: email } }]
          },
          token: {
            rich_text: [{ text: { content: token } }]
          },
          expires_at: {
            date: { start: expiresAt }
          },
          used: {
            checkbox: false
          }
        }
      })
    }
  );

  const result = await notionResponse.json();

  if (!notionResponse.ok) {
    return res.status(500).json({ error: "Erreur Notion" });
  }

  console.log("✅ Token créé :", token);
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const magicLink = `${BASE_URL}/login/verify?token=${token}`;

await resend.emails.send({
from: "Mémoire personnelle <onboarding@resend.dev>",
  to: "caro_gobeil@hotmail.com",
  subject: "Ton accès à ta mémoire personnelle",
  html: `
    <p>Bonjour,</p>

    <p>Tu as demandé l’accès à ta mémoire personnelle.</p>

    <p>
Clique simplement sur ce lien pour entrer :
</p>

<p>
      <a href="${magicLink}">${magicLink}</a>
    </p>

<p>
Aucun mot de passe.<br />
Aucune configuration.<br />
Juste ta mémoire, disponible quand tu en as besoin.
</p>

<p>
⏳ Ce lien est valide pour quelques minutes et ne peut être utilisé qu’une seule fois.
</p>

<p>
À tout de suite,<br />
Caroline
</p>
  `
});
console.log("📧 Email envoyé à", email);
  res.json({ success: true });

} catch (error) {
  console.error("❌ Erreur serveur :", error);
  res.status(500).json({ error: "Erreur serveur" });
}

});

app.get("/login/verify", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send("Lien invalide.");
  }

  try {
    // 🔍 chercher le token dans LoginTokens
    const response = await fetch(
      "https://api.notion.com/v1/databases/2fc1c666d4838033810dec41019b6ce9/query",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filter: {
            property: "token",
            rich_text: {
              equals: token
            }
          }
        })
      }
    );

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return res.send("Token non trouvé ❌");
    }

    const tokenPage = data.results[0];
    const props = tokenPage.properties;

    // ⏰ expiration
    const expiredRaw = props["expires_at"]?.date?.start;
    if (!expiredRaw) {
      return res.send("Lien expiré ❌");
    }

    const expiresAtMs = Date.parse(expiredRaw);
    const nowMs = Date.now();

    if (expiresAtMs < nowMs) {
      return res.send("Lien expiré ❌");
    }

    // 🔒 déjà utilisé ?
    if (props["used"]?.checkbox) {
      return res.send("Lien déjà utilisé ❌");
    }

    // ✅ marquer comme utilisé
    await fetch(
      `https://api.notion.com/v1/pages/${tokenPage.id}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            used: { checkbox: true }
          }
        })
      }
    );

// 📧 récupérer l’email depuis Notion
const email = props["email"]?.title?.[0]?.plain_text;

// 🍪 créer la session utilisateur (cookie)
res.cookie("user_email", email, {
  httpOnly: true,
  path: "/", // ⭐⭐⭐ CRUCIAL
  maxAge: 7 * 24 * 60 * 60 * 1000
});

// ➡️ redirection vers l’assistant
res.redirect("/");

  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur serveur");
  }
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/me", (req, res) => {
  if (!req.cookies.user_email) {
    return res.status(401).json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    email: req.cookies.user_email
  });
});

app.post("/logout", (req, res) => {
  res.clearCookie("user_email", {
    path: "/"
  });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});

