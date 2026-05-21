import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getStatus(payload) {
  return (
    payload.status ||
    payload.payment_status ||
    payload.data?.status ||
    payload.data?.payment_status ||
    payload.event ||
    ""
  ).toString().toLowerCase();
}

function isSuccessfulPayment(payload) {
  const status = getStatus(payload);
  const event = (payload.event || "").toString().toLowerCase();
  const scenario = (payload.data?.scenario || "").toString().toLowerCase();

  return (
    status === "completed" ||
    status === "success" ||
    status === "successful" ||
    status === "paid" ||
    status === "approved" ||
    status === "succeeded" ||
    event === "payment.success" ||
    scenario === "success"
  );
}

function getProviderReference(payload) {
  return (
    payload.reference ||
    payload.payment_reference ||
    payload.transaction_reference ||
    payload.data?.reference ||
    payload.data?.payment_reference ||
    payload.data?.transaction_reference ||
    null
  );
}

function getInvoiceId(payload) {
  return (
    payload.metadata?.invoice_id ||
    payload.data?.metadata?.invoice_id ||
    payload.invoice_id ||
    null
  );
}

function getTransactionId(payload) {
  return (
    payload.metadata?.transaction_id ||
    payload.data?.metadata?.transaction_id ||
    payload.transaction_id ||
    null
  );
}

async function supabaseFetch(path, options = {}) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  return fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function findTransaction(payload) {
  const transactionId = getTransactionId(payload);
  const providerReference = getProviderReference(payload);
  const invoiceId = getInvoiceId(payload);

  // 1. Recherche directe avec transaction_id envoyé dans metadata
  if (transactionId) {
    const response = await supabaseFetch(
      `/rest/v1/payment_transactions?id=eq.${encodeURIComponent(transactionId)}&select=*`
    );

    const data = response.ok ? await response.json() : [];
    if (data?.[0]) return data[0];
  }

  // 2. Recherche avec référence GeniusPay
  if (providerReference) {
    const response = await supabaseFetch(
      `/rest/v1/payment_transactions?provider_reference=eq.${encodeURIComponent(providerReference)}&select=*`
    );

    const data = response.ok ? await response.json() : [];
    if (data?.[0]) return data[0];
  }

  // 3. Recherche avec invoice_id si nécessaire
  if (invoiceId) {
    const response = await supabaseFetch(
      `/rest/v1/payment_transactions?invoice_id=eq.${encodeURIComponent(invoiceId)}&status=eq.pending&select=*`
    );

    const data = response.ok ? await response.json() : [];
    if (data?.[0]) return data[0];
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Méthode non autorisée"
    });
  }

  const {
    GENIUSPAY_WEBHOOK_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  if (!GENIUSPAY_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      success: false,
      message: "Variables serveur manquantes"
    });
  }

  try {
    const rawPayload = await readRawBody(req);

    const signature = getHeader(req, "x-webhook-signature");
    const timestamp = getHeader(req, "x-webhook-timestamp");
    const eventType = getHeader(req, "x-webhook-event");

    if (!signature || !timestamp) {
      return res.status(401).json({
        success: false,
        message: "Signature webhook manquante"
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", GENIUSPAY_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawPayload}`)
      .digest("hex");

    if (Buffer.from(expectedSignature).length !== Buffer.from(signature).length) {
      return res.status(401).json({
        success: false,
        message: "Signature webhook invalide"
      });
    }

    const validSignature = crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );

    if (!validSignature) {
      return res.status(401).json({
        success: false,
        message: "Signature webhook invalide"
      });
    }

    const payload = JSON.parse(rawPayload);

    const eventId = payload.id || payload.event_id || payload.data?.id;
    const providerReference = getProviderReference(payload);

    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: "Event ID manquant"
      });
    }

    // Vérifier si l’événement existe déjà
    const eventCheckResponse = await supabaseFetch(
      `/rest/v1/payment_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=id`
    );

    const existingEvents = eventCheckResponse.ok
      ? await eventCheckResponse.json()
      : [];

    // On enregistre l'événement seulement s'il n'existe pas encore
    if (existingEvents.length === 0) {
      await supabaseFetch(`/rest/v1/payment_webhook_events`, {
        method: "POST",
        body: JSON.stringify({
          provider: "geniuspay",
          event_id: eventId,
          event_type: eventType || payload.event || payload.type || null,
          provider_reference: providerReference,
          raw_payload: payload
        })
      });
    }

    // Si le paiement n'est pas confirmé, on garde juste la trace
    if (!isSuccessfulPayment(payload)) {
      return res.status(200).json({
        success: true,
        message: "Événement reçu, paiement non confirmé"
      });
    }

    const transaction = await findTransaction(payload);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction locale introuvable"
      });
    }

    // Si déjà validée, on évite le double traitement
    if (transaction.status === "success") {
      return res.status(200).json({
        success: true,
        message: "Transaction déjà validée"
      });
    }

    // Mettre la transaction en success
    await supabaseFetch(
      `/rest/v1/payment_transactions?id=eq.${transaction.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "success",
          provider_reference: providerReference || transaction.provider_reference,
          raw_response: payload,
          updated_at: new Date().toISOString()
        })
      }
    );

    // Marquer la facture comme payée
    const rpcResponse = await supabaseFetch(`/rest/v1/rpc/mark_invoice_paid`, {
      method: "POST",
      body: JSON.stringify({
        p_invoice_id: transaction.invoice_id
      })
    });

    if (!rpcResponse.ok) {
      const text = await rpcResponse.text();

      return res.status(500).json({
        success: false,
        message: "Paiement reçu mais erreur validation facture",
        details: text
      });
    }

    return res.status(200).json({
      success: true,
      message: "Paiement confirmé et facture validée"
    });

  } catch (error) {
    console.error("payment-webhook error:", error);

    return res.status(500).json({
      success: false,
      message: "Erreur serveur webhook",
      details: error.message
    });
  }
}
