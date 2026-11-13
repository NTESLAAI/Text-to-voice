const en = {
  translation: {
    bankPolicy: {
      account: "Receiving bank account",
      unknown: "Unknown",
      spendable: "Spendable surplus",
      unverified: "Insufficient evidence",
      reviewRequired:
        "Reconciliation totals do not establish the source of funds. Review is required before confirmation or surplus handling.",
    },
    auth: {
      login: {
        errors: {
          required: "Please enter all sign-in details.",
          invalidRequest: "Your sign-in details are invalid. Please check them and try again.",
          invalidCredentials: "Incorrect email/phone number or password. Please check and try again.",
          forbidden: "Your sign-in request was denied. Contact support if needed.",
          rateLimited: "Too many sign-in attempts. Please try again later.",
          serverError: "The service is experiencing an error. Please try again later.",
          connectionError: "Unable to connect to the server. Please check your network connection.",
          timeout: "The sign-in request timed out. Please try again.",
          sessionStorage: "Unable to save the sign-in session on this device. Please try again.",
          unexpected: "Unable to complete sign-in. Please try again.",
        },
      },
    },
    mobile: { externallyManaged: "This subscription is managed by the app store. Use the corresponding app to manage it; do not pay by bank transfer for overlapping access.", billing: 'App store subscriptions', policyPending: 'New purchases are temporarily disabled pending renewal and cross-platform policy approval.', notConfigured: 'No store-confirmed products or prices are available.', buy: 'Subscribe', restore: 'Restore purchases', manage: 'Manage / cancel subscription', verified: 'Verification submitted. Access is determined by the backend; a purchase may require review.', failed: 'Unable to complete. Check your connection, sign-in session or contact support.', exportAudio: 'Download / save audio' },
    app: {
      title: "TEXT-TO-VOICE",
      subtitle: "TEXT TO SPEECH",
    },

    language: {
      label: "Language",
      vietnamese: "Vietnamese",
      english: "English",
    },

    tts: {
      title: "TEXT-TO-VOICE",
      placeholder: "Enter text to speak...",
      generate: "Generate Voice",
      generating: "Generating voice...",
      characters: "{{count}} / 5000 characters",
      history: "Audio History",
      play: "Play",
      delete: "Delete",
      duration: "{{duration}} seconds",
      empty: "No audio yet.",
      confirmDelete: "Are you sure you want to delete this audio?",
    },

    common: {
      error: "Something went wrong.",
      loading: "Loading...",
      confirmLogout: "Are you sure you want to log out?",
      yes: "Yes",
      cancel: "Cancel",
    },
  },
};

export default en;
