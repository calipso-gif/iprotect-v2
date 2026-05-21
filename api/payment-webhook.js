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

function isSuccessfulPayment(payload) {
  const status = (
    payload.status ||
    payload.payment_status ||
    payload.data?.status ||
    payload.data?.payment_status ||
    ""
  ).toString().toLowerCase();

  return [
    "success",
    "successful",
    "paid",
    "completed",
    "approved",
    "succeeded"
  ].includes(status);
}

function getProviderReference(payload) {
  return (
    payload.reference ||
    payload.payment_reference ||
    payload.transaction_reference ||
    payload.data?.reference ||
    payload.data?.payment_reference ||
    payload.data?.transaction_reference ||
    payload.data?.id ||
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

    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: "Event ID manquant"
      });
    }

    const providerReference = getProviderReference(payload);
    const invoiceIdFromMetadata = getInvoiceId(payload);

    const eventCheckResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=id`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const existingEvents = eventCheckResponse.ok
      ? await eventCheckResponse.json()
      : [];

    if (existingEvents.length > 0) {
      return res.status(200).json({
        success: true,
        message: "Webhook déjà traité"
      });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/payment_webhook_events`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "geniuspay",
        event_id: eventId,
        event_type: eventType || payload.event || payload.type || null,
        provider_reference: providerReference,
        raw_payload: payload
      })
    });

    if (!isSuccessfulPayment(payload)) {
      return res.status(200).json({
        success: true,
        message: "Événement reçu, paiement non confirmé"
      });
    }

    let transaction = null;

    if (providerReference) {
      const transactionResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/payment_transactions?provider_reference=eq.${encodeURIComponent(providerReference)}&select=*`,
        {
          method: "GET",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const transactions = transactionResponse.ok
        ? await transactionResponse.json()
        : [];

      transaction = transactions?.[0] || null;
    }

    if (!transaction && invoiceIdFromMetadata) {
      const transactionResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/payment_transactions?invoice_id=eq.${encodeURIComponent(invoiceIdFromMetadata)}&status=eq.pending&select=*`,
        {
          method: "GET",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const transactions = transactionResponse.ok
        ? await transactionResponse.json()
        : [];

      transaction = transactions?.[0] || null;
    }

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction locale introuvable"
      });
    }

    await fetch(
      `${SUPABASE_URL}/rest/v1/payment_transactions?id=eq.${transaction.id}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          status: "success",
          raw_response: payload,
          updated_at: new Date().toISOString()
        })
      }
    );

    const rpcResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/mark_invoice_paid`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
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
