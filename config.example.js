// Nova Configuration Template
// RENAME THIS TO config.js AND FILL IN YOUR KEYS
const CONFIG = {
    FIREBASE_CONFIG: {
        apiKey: "YOUR_FIREBASE_API_KEY",
        authDomain: "YOUR_APP.firebaseapp.com",
        projectId: "YOUR_PROJECT_ID",
        storageBucket: "YOUR_BUCKET.appspot.com",
        messagingSenderId: "YOUR_SENDER_ID",
        appId: "YOUR_APP_ID",
        measurementId: "YOUR_MEASUREMENT_ID"
    },
    GROQ_API_KEY: "YOUR_GROQ_API_KEY"
};

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
} else {
    window.NOVA_CONFIG = CONFIG;
}
