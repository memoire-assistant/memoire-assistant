require("dotenv").config();

const { Resend } = require("resend");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const express = require("express");
const cookieParser = require("cookie-parser");
const { DateTime } = require("luxon");
const webpush = require('web-push');

// ✅ Supabase remplace Notion
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // utilise la clé "service_role" pour bypasser RLS
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

app.use(express.static("public"));
app.use(express.json());
app.use(cookieParser());

const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:caro_gobeil@hotmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

app.post("/message", async (req, res) => {
  const userEmail = req.cookies.user_email;

  if (!userEmail) {
    return res.status(401).json({
      error: "Utilisateur non connecté"
    });
  }

  const userMessage = req.body.message;
  console.log("Message reçu :", userMessage);

  // 🔍 Récupérer l'ID utilisateur depuis Supabase
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", userEmail)
    .single();

  if (userError || !userData) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  const userId = userData.id;

  const intentCheck = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Tu dois répondre uniquement par "QUESTION" ou "NOTE".

QUESTION = l'utilisateur cherche une information déjà notée.
NOTE = l'utilisateur dépose une nouvelle information.
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

  // 🧠 CAS 1 : l'utilisateur pose une QUESTION → on cherche dans sa mémoire
  if (intent === "QUESTION") {

    // 📝 Récupérer TOUTES les notes de l'utilisateur (Supabase n'a pas de limite de pagination comme Notion)
    const { data: allNotes, error: notesError } = await supabase
      .from("notes")
      .select("titre, contenu")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (notesError) {
      console.error("Erreur Supabase:", notesError);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    // 🧩 Construire le contexte mémoire
    const memoryContext = allNotes
      .map(note => {
        if (!note.titre && !note.contenu) return null;
        return `• ${note.titre} — ${note.contenu}`;
      })
      .filter(Boolean)
      .join("\n");

    // 🧠 Demander à l'IA de répondre UNIQUEMENT à partir de la mémoire
    const answerCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Tu es une mémoire personnelle calme et fiable.

Voici des notes précédentes de l'utilisateur :
${memoryContext || "Aucune note disponible."}

Règles :
- Réponds uniquement avec les informations présentes ci-dessus.
- N'invente rien.
- Si l'information n'est pas trouvable, dis-le simplement.
`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const answer = answerCompletion.choices[0].message.content.trim();

    // ✅ On répond et on SORT — aucune création de note
    return res.json({
      reply: answer
    });
  }

  // 📝 CAS 2 : l'utilisateur veut NOTER quelque chose

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
Le fuseau horaire de l'utilisateur est ${userTimezone}.
Toutes les dates et heures doivent être interprétées dans ce fuseau.

Tu es une mémoire externe calme et fiable.

Tu dois TOUJOURS créer une entrée pour l'utilisateur.

Champs disponibles :
- titre
- contenu brut
- date de rappel (optionnelle)

Règles :
- Ne pose jamais de question.
- Fais une hypothèse raisonnable si une date est floue.
- Si aucune date n'est détectable, mets null.
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

// 🕐 Convertir la date de rappel du fuseau utilisateur vers UTC
let dateRappelUTC = null;
if (aiResponse.date_rappel) {
  // L'IA retourne ex: "2026-02-19T18:00" (sans timezone)
  // On doit l'interpréter comme étant dans le fuseau de l'utilisateur
  
  const dateInUserTZ = DateTime.fromISO(aiResponse.date_rappel, {
    zone: userTimezone // "America/Toronto"
  });
  
  // Convertir en UTC pour Supabase
  dateRappelUTC = dateInUserTZ.toUTC().toISO();
  
  console.log(`📅 Date entrée par user: ${aiResponse.date_rappel} (${userTimezone})`);
  console.log(`📅 Date stockée (UTC): ${dateRappelUTC}`);
}

// 2. ✅ Écriture dans Supabase
const { error: insertError } = await supabase
  .from("notes")
  .insert({
    user_id: userId,
    titre: aiResponse.titre,
    contenu: aiResponse.contenu,
    date_rappel: dateRappelUTC
  });

  if (insertError) {
    console.error("Erreur insertion Supabase:", insertError);
    return res.status(500).json({ error: "Erreur lors de la sauvegarde" });
  }

  // 3. Réponse utilisateur (simple, calme)
  res.json({
    reply: "C'est noté. Je m'en souviens pour toi."
  });
});

app.post("/login", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email manquant" });
  }

  const token = Math.random().toString(36).substring(2, 15);

  // Expiration : maintenant + 10 minutes (UTC ISO)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
    // 🔐 Créer le token dans Supabase
    const { error: tokenError } = await supabase
      .from("login_tokens")
      .insert({
        email: email,
        token: token,
        expires_at: expiresAt,
        used: false
      });

    if (tokenError) {
      console.error("Erreur Supabase:", tokenError);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    console.log("✅ Token créé :", token);

    const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
    const magicLink = `${BASE_URL}/login/verify?token=${token}`;

    await resend.emails.send({
      from: "Mémoire personnelle <onboarding@resend.dev>",
      to: email,
      subject: "Ton accès à ta mémoire personnelle",
      html: `
    <p>Bonjour,</p>

    <p>Tu as demandé l'accès à ta mémoire personnelle.</p>

    <p>Clique simplement sur ce lien pour entrer :</p>

    <p>
      <a href="${magicLink}">${magicLink}</a>
    </p>

    <p>
      Aucun mot de passe.<br />
      Aucune configuration.<br />
      Juste ta mémoire, disponible quand tu en as besoin.
    </p>

    <p>
      ⏳ Ce lien est valide pour quelques minutes et ne peut être utilisé qu'une seule fois.
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
    // 🔍 Chercher le token dans Supabase
    const { data: tokenData, error: tokenError } = await supabase
      .from("login_tokens")
      .select("*")
      .eq("token", token)
      .single();

    if (tokenError || !tokenData) {
      return res.send("Token non trouvé ❌");
    }

    // ⏰ Vérifier expiration
    const expiresAtMs = Date.parse(tokenData.expires_at);
    const nowMs = Date.now();

    if (expiresAtMs < nowMs) {
      return res.send("Lien expiré ❌");
    }

    // 🔒 Déjà utilisé ?
    if (tokenData.used) {
      return res.send("Lien déjà utilisé ❌");
    }

    // ✅ Marquer comme utilisé
    await supabase
      .from("login_tokens")
      .update({ used: true })
      .eq("token", token);

    const email = tokenData.email;

    // 👤 Créer l'utilisateur s'il n'existe pas (upsert)
    const { error: userError } = await supabase
      .from("users")
      .upsert({ email: email }, { onConflict: "email" });

    if (userError) {
      console.error("Erreur création user:", userError);
    }

    // 🍪 Créer la session utilisateur (cookie)
    res.cookie("user_email", email, {
      httpOnly: true,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // ➡️ Redirection vers l'assistant
    res.redirect("/");

  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur serveur");
  }
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/get-notes", async (req, res) => {
  const userEmail = req.cookies.user_email;

  if (!userEmail) {
    return res.status(401).json({ error: "Non connecté" });
  }

  try {
    // Récupérer l'ID utilisateur
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("id")
      .eq("email", userEmail)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    // Récupérer toutes les notes de l'utilisateur, triées par date de création
    const { data: notes, error: notesError } = await supabase
      .from("notes")
      .select("titre, contenu, date_rappel, created_at")
      .eq("user_id", userData.id)
      .order("created_at", { ascending: false });

    if (notesError) {
      console.error("Erreur Supabase:", notesError);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    res.json({ notes: notes || [] });

  } catch (error) {
    console.error("Erreur:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
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

// ============ ENDPOINT : Sauvegarder la souscription push ============
app.post("/api/save-push-subscription", async (req, res) => {
  try {
    const userEmail = req.cookies.user_email;
    
    if (!userEmail) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const subscription = req.body;

    // Récupérer l'ID utilisateur
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("id")
      .eq("email", userEmail)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    // Sauvegarder la souscription dans la table users
    const { error: updateError } = await supabase
      .from("users")
      .update({ push_subscription: subscription })
      .eq("id", userData.id);

    if (updateError) {
      console.error("❌ Erreur sauvegarde souscription:", updateError);
      return res.status(500).json({ error: "Erreur sauvegarde" });
    }

    console.log("✅ Souscription push sauvegardée pour user:", userData.id);
    res.json({ success: true });

  } catch (error) {
    console.error("❌ Erreur endpoint save-push-subscription:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});