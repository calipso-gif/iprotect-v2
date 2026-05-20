export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Méthode non autorisée"
    });
  }

  try {
    const {
      GENIUSPAY_API_KEY,
      GENIUSPAY_API_SECRET,
      GENIUSPAY_BASE_URL,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    } = process.env;

    if (
      !GENIUSPAY_API_KEY ||
      !GENIUSPAY_API_SECRET ||
      !GENIUSPAY_BASE_URL ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return res.status(500).json({
        success: false,
        message: "Variables d'environnement manquantes."
      });
    }

    const { invoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        message: "Facture manquante."
      });
    }

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Session client manquante."
      });
    }

    const clientToken = authHeader.replace("Bearer ", "");

    // 1. Vérifier l'utilisateur connecté avec Supabase Auth
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${clientToken}`
      }
    });

    if (!userResponse.ok) {
      return res.status(401).json({
        success: false,
        message: "Session invalide."
      });
    }

    const user = await userResponse.json();

    if (!user?.id) {
      return res.status(401).json({
        success: false,
        message: "Utilisateur introuvable."
      });
    }

    // 2. Récupérer la facture du client
    const invoiceResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoiceId}&user_id=eq.${user.id}&select=*`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!invoiceResponse.ok) {
      const text = await invoiceResponse.text();
      return res.status(500).json({
        success: false,
        message: "Erreur récupération facture.",
        details: text
      });
    }

    const invoices = await invoiceResponse.json();
    const invoice = invoices?.[0];

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Facture introuvable."
      });
    }

    if (invoice.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Cette facture est déjà payée."
      });
    }

    // 3. Récupérer le profil client
    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=full_name,email,phone`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const profiles = profileResponse.ok ? await profileResponse.json() : [];
    const profile = profiles?.[0] || {};

    const amount =
      Number(invoice.total_amount || 0) > 0
        ? Number(invoice.total_amount || 0)
        : Number(invoice.amount || 0);

    if (!amount || amount < 200) {
      return res.status(400).json({
        success: false,
        message: "Montant invalide."
      });
    }

    // 4. Créer une transaction locale pending
    const transactionResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_transactions`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          invoice_id: invoice.id,
          user_id: user.id,
          provider: "geniuspay",
          amount: amount,
          currency: "XOF",
          status: "pending"
        })
      }
    );

    if (!transactionResponse.ok) {
      const text = await transactionResponse.text();
      return res.status(500).json({
        success: false,
        message: "Erreur création transaction locale.",
        details: text
      });
    }

    const createdTransactions = await transactionResponse.json();
    const transaction = createdTransactions?.[0];

    // 5. Créer le paiement GeniusPay
    const geniusResponse = await fetch(`${GENIUSPAY_BASE_URL}/payments`, {
      method: "POST",
      headers: {
        "X-API-Key": GENIUSPAY_API_KEY,
        "X-API-Secret": GENIUSPAY_API_SECRET,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: amount,
        currency: "XOF",
        description: `I-PROTECT - Facture ${invoice.invoice_type || "abonnement"}`,
        customer: {
          name: profile.full_name || "Client I-PROTECT",
          email: profile.email || user.email || "",
          phone: profile.phone || "",
          country: "CI"
        },
        success_url: "https://iprotect-ci.vercel.app/paiements-client.html",
        error_url: "https://iprotect-ci.vercel.app/paiements-client.html",
        metadata: {
          invoice_id: invoice.id,
          user_id: user.id,
          transaction_id: transaction.id,
          invoice_type: invoice.invoice_type || "subscription"
        }
      })
    });

    const geniusData = await geniusResponse.json().catch(() => null);

    if (!geniusResponse.ok || !geniusData?.success) {
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
            status: "failed",
            raw_response: geniusData || {}
          })
        }
      );

      return res.status(400).json({
        success: false,
        message: "Erreur création paiement GeniusPay.",
        details: geniusData
      });
    }

    const paymentData = geniusData.data || {};
    const paymentUrl = paymentData.checkout_url || paymentData.payment_url;

    if (!paymentUrl) {
      return res.status(400).json({
        success: false,
        message: "Lien de paiement GeniusPay introuvable.",
        details: geniusData
      });
    }

    // 6. Enregistrer la référence GeniusPay
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
          provider_reference: paymentData.reference || null,
          payment_url: paymentUrl,
          raw_response: geniusData,
          updated_at: new Date().toISOString()
        })
      }
    );

    return res.status(200).json({
      success: true,
      payment_url: paymentUrl,
      reference: paymentData.reference || null
    });

  } catch (error) {
    console.error("create-payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Erreur serveur création paiement.",
      details: error.message
    });
  }
}
