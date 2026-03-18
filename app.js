// Core Nova Assistant Logic
const micBtn = document.getElementById('mic-btn');
const statusText = document.getElementById('status-text');
const novaResponse = document.getElementById('nova-response');
const userTranscript = document.getElementById('user-transcript');
const indMic = document.getElementById('ind-mic');
const indNet = document.getElementById('ind-net');
const indApi = document.getElementById('ind-api');
const indCloud = document.getElementById('ind-cloud');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const uploadBtn = document.getElementById('upload-btn');
const fileInput = document.getElementById('file-input');
const zenithSpinner = document.getElementById('zenith-spinner');
const voiceSelect = document.getElementById('voice-select');
const fbConfigInput = document.getElementById('fb-config-input');

// Visualization DOM
const lockStatus = document.getElementById('lock-status');
const vpCanvas = document.getElementById('voiceprint-canvas');
const matchScoreDisplay = document.getElementById('match-score');
const vpCtx = vpCanvas.getContext('2d');
const resetVpBtn = document.getElementById('reset-vp');
const resetBiometricsBtn = document.getElementById('reset-biometrics');
const backupVpBtn = document.getElementById('backup-vp');
const memoryDisplay = document.getElementById('memory-display');
const apiKeyInput = document.getElementById('api-key-input');

// Biometric & Enrollment Variables
const enrollBtn = document.getElementById('enroll-btn');
const enrollmentModal = document.getElementById('enrollment-modal');
const closeEnroll = document.getElementById('close-enroll');
const currentPhrase = document.getElementById('current-phrase');
const enrollProgress = document.getElementById('enroll-progress');
const startEnrollStep = document.getElementById('start-enroll-step');
const enrollmentStepText = document.getElementById('enroll-step-text');

// Drawer & Settings DOM
const menuToggle = document.getElementById('menu-toggle');
const settingsDrawer = document.getElementById('settings-drawer');
const closeDrawer = document.getElementById('close-drawer');
const saveSettingsBtn = document.getElementById('save-all-settings');
const drawerGroqKey = document.getElementById('drawer-groq-key');
const drawerSecondaryKey = document.getElementById('drawer-secondary-key');
const drawerFbKey = document.getElementById('drawer-fb-key');
const drawerFbPid = document.getElementById('drawer-fb-pid');
const drawerThemeToggle = document.getElementById('drawer-theme-toggle');

let isEnrolling = false;
let isListening = false;
let isProcessing = false; 
let isSpeaking = false; 
let enrollmentIteration = parseInt(localStorage.getItem('nova_enroll_iter')) || 0;
let enrollmentStep = parseInt(localStorage.getItem('nova_enroll_step')) || 0;
let enrollmentSamples = JSON.parse(localStorage.getItem('nova_enroll_samples')) || [];
let userVoiceprint = JSON.parse(localStorage.getItem('nova_voiceprint')) || null;
const phrases = [
    "Nova, begin secure voice enrollment.",
    "The quick brown fox jumps over the lazy dog.",
    "My voice is the unique key to this system.",
    "Nova, lock all commands to my vocal signature."
];
const REPEATS_REQUIRED = 3;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;

// Database System (IndexedDB)
let db;
let firebaseActive = false;
const DB_NAME = "NovaDB";
const DB_VERSION = 1;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('memory')) db.createObjectStore('memory');
            if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { autoIncrement: true });
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject(e);
    });
}

async function getFromDB(key) {
    return new Promise((resolve) => {
        const tx = db.transaction('memory', 'readonly');
        const store = tx.objectStore('memory');
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
    });
}

function setToDB(key, val) {
    const tx = db.transaction('memory', 'readwrite');
    const store = tx.objectStore('memory');
    store.put(val, key);
}

// Memory System Variables
let userMemory = {
    name: "User",
    facts: [],
    preferences: {}
};

async function loadMemory() {
    await initDB();
    const saved = await getFromDB('user_memory');
    if (saved) {
        userMemory = saved;
    } else {
        // Migration from localStorage
        const legacy = localStorage.getItem('nova_memory');
        if (legacy) {
            userMemory = JSON.parse(legacy);
            setToDB('user_memory', userMemory);
        }
    }
    updateMemoryUI();
}

// Always-On Mode
let alwaysOn = false; // Start false, enable on first mic click
let chatContext = []; 
const MAX_CONTEXT = 5; 

// Sound Effects — DEFERRED to first user gesture to avoid browser autoplay block
let audioCtxFeedback = null;
function ensureFeedbackAudio() {
    if (!audioCtxFeedback) {
        audioCtxFeedback = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxFeedback.state === 'suspended') audioCtxFeedback.resume();
}
function playBeep(freq = 440, duration = 0.1) {
    try {
        ensureFeedbackAudio();
        const osc = audioCtxFeedback.createOscillator();
        const gain = audioCtxFeedback.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.1, audioCtxFeedback.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtxFeedback.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtxFeedback.destination);
        osc.start();
        osc.stop(audioCtxFeedback.currentTime + duration);
    } catch(e) { console.warn('Beep failed:', e); }
}

// Safety: Reset stuck state flags after 15 seconds
setInterval(() => {
    if (isProcessing && !zenithSpinner.classList.contains('active')) {
        console.warn('Safety: Resetting stuck isProcessing flag');
        isProcessing = false;
    }
    if (isSpeaking && !window.speechSynthesis.speaking) {
        console.warn('Safety: Resetting stuck isSpeaking flag');
        isSpeaking = false;
        micBtn.classList.remove('speaking');
    }
}, 5000);

// Voice Selection Logic
let voices = [];

function populateVoiceList() {
    const allVoices = window.speechSynthesis.getVoices();
    voiceSelect.innerHTML = '';
    
    // We want to find 2 male and 2 female-sounding voices
    // Windows: David/Mark (Male), Zira (Female), Haruka/Sabina (Cute/Soft)
    // Mac/iOS: Daniel/Arthur (Male), Samantha/Karen (Female), Siri/Nicky (Cute)
    
    const targets = [
        { namePattern: /(irish|siobhan|moira|en-IE)/i, label: "FRIDAY (Digital Soul)", type: "friday" },
        { namePattern: /(british|uk|england|serena|daniel)/i, label: "Nova (Sophisticated)", type: "friday" },
        { namePattern: /(zira|samantha|karen|siri)/i, label: "Nova (Standard Female)", type: "female" },
        { namePattern: /(haruka|sabina|soft|cute|nicky|google us english)/i, label: "Nova (Cute/Soft)", type: "female" }
    ];

    voices = [];
    targets.forEach(target => {
        const found = allVoices.find(v => target.namePattern.test(v.name));
        if (found) {
            const option = document.createElement('option');
            option.textContent = target.label;
            option.setAttribute('data-name', found.name);
            voiceSelect.appendChild(option);
            voices.push(found);
        }
    });

    // Fallback if no specific voices matched
    if (voiceSelect.childElementCount === 0) {
        allVoices.slice(0, 4).forEach((v, i) => {
            const option = document.createElement('option');
            option.textContent = `Voice ${i + 1} (${v.name})`;
            option.setAttribute('data-name', v.name);
            voiceSelect.appendChild(option);
            voices.push(v);
        });
    }
}

// Firebase/Intelligence Config - Loaded from config.js
const fbConfig = window.NOVA_CONFIG ? window.NOVA_CONFIG.FIREBASE_CONFIG : null;
const groqKey = window.NOVA_CONFIG ? window.NOVA_CONFIG.GROQ_API_KEY : '';

// Initialize UI
loadMemory(); 
updateLockUI();
updateNetworkStatus();
populateVoiceList();

// Start Firebase with highest priority config
function getEffectiveFirebaseConfig() {
    const localKey = localStorage.getItem('nova_fb_key');
    const localPid = localStorage.getItem('nova_fb_pid');
    
    // Default from config.js
    let config = fbConfig ? {...fbConfig} : {};
    
    // Override with localStorage if present
    if (localKey) config.apiKey = localKey;
    if (localPid) config.projectId = localPid;
    
    return config.apiKey && config.projectId ? config : null;
}

const effectiveConfig = getEffectiveFirebaseConfig();
if (effectiveConfig) initFirebase(effectiveConfig);

async function initFirebase(config) {
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(config);
        }
        
        firebaseActive = true;
        const fs = firebase.firestore();
        const auth = firebase.auth();
        
        indCloud.classList.add('active');
        indCloud.title = "Cloud Active";
        
        // Auth State Observer
        auth.onAuthStateChanged(user => {
            const authBtn = document.getElementById('auth-btn');
            const userDisplayName = document.getElementById('user-display-name');
            const userEmail = document.getElementById('user-email');
            const userPhoto = document.getElementById('user-photo');

            if (user) {
                userDisplayName.textContent = user.displayName || "User";
                userEmail.textContent = user.email;
                if (user.photoURL) userPhoto.src = user.photoURL;
                authBtn.textContent = "Logout";
                indCloud.classList.add('active');
                attachCloudSync(user); // Start real-time sync for this specific user
            } else {
                userDisplayName.textContent = "Guest Mode";
                userEmail.textContent = "cloud-brain@nova.ai";
                userPhoto.src = "https://ui-avatars.com/api/?name=Nova&background=00d2ff&color=fff";
                authBtn.textContent = "Connect";
            }
        });

        // Auth Action
        document.getElementById('auth-btn').addEventListener('click', () => {
            const currentAuth = firebase.auth();
            if (currentAuth.currentUser) {
                currentAuth.signOut().then(() => location.reload()); // Reload to clear session state safely
            } else {
                const provider = new firebase.auth.GoogleAuthProvider();
                currentAuth.signInWithPopup(provider).catch(e => {
                    console.error("Auth Error:", e);
                    statusText.textContent = "Auth Failed: " + e.message;
                });
            }
        });

        displayAndSpeak("Cloud Brain connected. Your memory is now universal.");
    } catch (e) {
        console.error("Firebase Init Error:", e);
        indCloud.classList.remove('active');
        indCloud.title = "Cloud Error";
    }
}

function attachCloudSync(user) {
    if (!firebaseActive || !user) return;
    const fs = firebase.firestore();
    
    // Use UID for secure isolation
    fs.collection('users').doc(user.uid).onSnapshot((doc) => {
        if (doc.exists) {
            const cloudData = doc.data().memory;
            if (JSON.stringify(cloudData) !== JSON.stringify(userMemory)) {
                userMemory = cloudData;
                setToDB('user_memory', userMemory);
                updateMemoryUI();
                console.log("Cloud memory synced (UID: " + user.uid + ")");
            }
        } else {
            // First time sync for this user - push local data up
            syncToCloud();
        }
    });
}

async function syncToCloud() {
    if (!firebaseActive) return;
    const user = firebase.auth().currentUser;
    if (!user) return; // Only sync if logged in now

    try {
        const fs = firebase.firestore();
        await fs.collection('users').doc(user.uid).set({
            memory: userMemory,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
            email: user.email,
            displayName: user.displayName
        }, { merge: true });
        console.log("Memory synced to cloud (UID: " + user.uid + ")");
    } catch (e) {
        console.error("Cloud Sync Error:", e);
    }
}

// Load API Key
apiKeyInput.value = localStorage.getItem('nova_api_key') || '';
apiKeyInput.addEventListener('input', () => {
    localStorage.setItem('nova_api_key', apiKeyInput.value);
});

// Text Input Handling
textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && textInput.value.trim()) {
        const cmd = textInput.value.trim();
        addChatMessage('user', cmd);
        textInput.value = '';
        processCommand(cmd);
    }
});

sendBtn.addEventListener('click', () => {
    if (textInput.value.trim()) {
        const cmd = textInput.value.trim();
        addChatMessage('user', cmd);
        textInput.value = '';
        processCommand(cmd);
    }
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileUpload);

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    zenithSpinner.classList.add('active');
    
    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = async (event) => {
            const base64 = event.target.result;
            displayAndSpeak(`Analyzing Image...`);
            const analysis = await fetchGlobalInfo(`Analyze this image carefully. Read any text and describe it.`, base64);
            displayAndSpeak(analysis);
        };
        reader.readAsDataURL(file);
    } else {
        // Text/PDF handling (Simplified for now)
        const reader = new FileReader();
        reader.onload = async (event) => {
            const content = event.target.result;
            displayAndSpeak(`Reading File...`);
            const analysis = await fetchGlobalInfo(`The user uploaded a document. Here is the start of the content: "${content.substring(0, 1000)}". Summarize or answer questions about it.`);
            displayAndSpeak(analysis);
        };
        reader.readAsText(file);
    }
}

window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

function updateNetworkStatus() {
    if (navigator.onLine) indNet.classList.add('active');
    else indNet.classList.remove('active');
}

if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoiceList;
}

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.lang = 'en-US';
    recognition.interimResults = true; 
    recognition.maxAlternatives = 3;

    let silenceTimer;
    const SILENCE_THRESHOLD = 700; // SNAPPY: Respond faster after user stops talking
    const openedTabs = []; // Track tabs for closing

    recognition.onstart = () => {
        isListening = true;
        isProcessing = false; // Reset on fresh listen
        window.speechSynthesis.cancel(); 
        playBeep(440, 0.1); 
        micBtn.classList.add('listening');
        statusText.textContent = "LISTENING: Give a command";
        indMic.classList.add('active');
        console.log('Recognition started successfully');
        
        if (!isEnrolling) {
            userTranscript.textContent = "Listening...";
            userTranscript.classList.add('searching');
        }
        
        if (!isEnrolling) {
            verificationSamples = [];
            if (analyser) {
                verificationInterval = setInterval(() => {
                    const sample = captureSignature();
                    if (sample) verificationSamples.push(sample);
                }, 100);
            }
        }
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
            else interimTranscript += event.results[i][0].transcript;
        }

        const currentText = (finalTranscript || interimTranscript).trim();
        if (!currentText) return;

        // IMMEDIATE TRANSCRIPTION: Show interim results instantly in the box
        if (!isEnrolling) {
            userTranscript.textContent = currentText;
        }

        // INSTANT STOP DETECTION
        const stopTriggers = ["stop", "cancel", "shut up", "quiet"];
        if (stopTriggers.some(t => currentText.toLowerCase().includes(t))) {
            window.speechSynthesis.cancel();
            isSpeaking = false;
            isProcessing = false;
            micBtn.classList.remove('speaking');
            statusText.textContent = "Protocol Interrupted";
            return;
        }

        // Reset silence timer
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (finalTranscript) {
                if (isEnrolling) {
                    handleEnrollmentResult();
                } else if (!isProcessing && !isSpeaking) {
                    recognition.stop();
                    userTranscript.textContent = finalTranscript;
                    processCommand(finalTranscript.toLowerCase());
                }
            }
        }, SILENCE_THRESHOLD);
    };

    recognition.onend = () => {
        isListening = false;
        console.log('Recognition ended. alwaysOn:', alwaysOn, 'isSpeaking:', isSpeaking, 'isProcessing:', isProcessing);
        if (verificationInterval) {
            clearInterval(verificationInterval);
            verificationInterval = null;
        }
        micBtn.classList.remove('listening');
        startEnrollStep.classList.remove('active');
        
        if (indMic.classList.contains('active')) {
            statusText.textContent = alwaysOn ? "STAYING ACTIVE: Give a command" : "Ready (Last session ended)";
        }
        indMic.classList.remove('active');
        
        // Always-On Auto-Restart with robust retry
        if (alwaysOn && !isEnrolling && !isSpeaking) {
            const restartDelay = isProcessing ? 2000 : 600;
            setTimeout(() => {
                if (alwaysOn && !isListening && !isSpeaking && !isEnrolling) {
                    try { 
                        recognition.start();
                        console.log('Auto-restarted recognition');
                    } catch(e) {
                        console.warn("Auto-restart collision:", e.message);
                        setTimeout(() => {
                            if (!isListening && !isSpeaking && alwaysOn) {
                                try { recognition.start(); } catch(e2) { console.error('Retry failed:', e2); }
                            }
                        }, 1500);
                    }
                }
            }, restartDelay);
        }
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        
        switch(event.error) {
            case 'not-allowed': 
                statusText.textContent = "ERROR: Mic access blocked. Please allow microphone."; 
                alwaysOn = false; // Stop retrying if permission denied
                break;
            case 'no-speech': 
                statusText.textContent = "IDLE: Waiting for voice..."; 
                break;
            case 'network': statusText.textContent = "ERROR: Network offline"; break;
            case 'audio-capture': statusText.textContent = "ERROR: Mic not found"; break;
            case 'aborted': statusText.textContent = "Mic paused"; break;
            default: statusText.textContent = "GLITCH: " + event.error;
        }
        
        isListening = false;
        micBtn.classList.remove('listening');
        indMic.classList.remove('active');

        // Auto-restart on recoverable errors
        if (alwaysOn && (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network')) {
            setTimeout(() => {
                if (alwaysOn && !isListening && !isSpeaking) {
                    try { recognition.start(); } catch(e) {}
                }
            }, 1500);
        }
    };
}
 else {
    statusText.textContent = "Your browser does not support Speech Recognition.";
    micBtn.disabled = true;
}

// Biometric Variables
// Audio Context for Spectral Analysis
let audioCtx;
let analyser;
let currentSpectralData = [];
let enrollmentInterval = null;
let verificationInterval = null;
let verificationSamples = [];

async function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
    } else if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

function captureSignature() {
    if (!analyser) return null;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);
    
    // Noise Floor Filter: Ignore inputs that are too quiet
    const sum = dataArray.reduce((p, c) => p + c, 0);
    if (sum < 200) return null; // Filter out true silence/background hum
    
    return Array.from(dataArray).map(v => v / 255);
}

function getCosineSimilarity(v1, v2) {
    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;
    for (let i = 0; i < v1.length; i++) {
        dotProduct += v1[i] * v2[i];
        mag1 += v1[i] * v1[i];
        mag2 += v2[i] * v2[i];
    }
    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);
    if (mag1 === 0 || mag2 === 0) return 0;
    return dotProduct / (mag1 * mag2);
}

// Enrollment Flow
enrollBtn.addEventListener('click', () => {
    isEnrolling = true;
    enrollmentModal.classList.add('active');
    startEnrollStep.style.display = ''; // BUG FIX: Un-hide the mic button after previous enrollment
    
    // Resume existing progress if available
    const savedStep = localStorage.getItem('nova_enroll_step');
    if (savedStep !== null) {
        enrollmentStep = parseInt(savedStep);
        enrollmentIteration = parseInt(localStorage.getItem('nova_enroll_iter')) || 0;
        enrollmentSamples = JSON.parse(localStorage.getItem('nova_enroll_samples')) || [];
    } else {
        enrollmentStep = 0;
        enrollmentIteration = 0;
        enrollmentSamples = [];
    }

    currentSpectralData = [];
    updateEnrollmentUI();
});

closeEnroll.addEventListener('click', () => {
    isEnrolling = false;
    enrollmentModal.classList.remove('active');
});

startEnrollStep.addEventListener('click', async () => {
    await initAudio();
    if (recognition) {
        if (isListening) {
            recognition.stop();
            startEnrollStep.classList.remove('active');
        } else {
            recognition.start();
            startEnrollStep.classList.add('active');
            currentSpectralData = []; 
            enrollmentInterval = setInterval(() => {
                const sig = captureSignature();
                if (sig) currentSpectralData.push(sig); // BUG FIX: Filter nulls
            }, 100);
        }
    }
});

async function handleEnrollmentResult() {
    if (enrollmentInterval) {
        clearInterval(enrollmentInterval);
        enrollmentInterval = null;
    }
    
    // Process the captured signatures for this iteration
    if (currentSpectralData && currentSpectralData.length > 0) {
        // Create an average signature for this specific iteration
        const iterationSig = currentSpectralData[0].map((_, i) => {
            return currentSpectralData.reduce((acc, profile) => acc + (profile[i] || 0), 0) / currentSpectralData.length;
        });
        enrollmentSamples.push(iterationSig);
        localStorage.setItem('nova_enroll_samples', JSON.stringify(enrollmentSamples));
    }

    // Iteration check (1, 2, 3)
    enrollmentIteration++;
    if (enrollmentIteration >= REPEATS_REQUIRED) {
        enrollmentIteration = 0;
        enrollmentStep++;
    }
    
    localStorage.setItem('nova_enroll_iter', enrollmentIteration);
    localStorage.setItem('nova_enroll_step', enrollmentStep);
    
    updateEnrollmentUI();
}

function updateEnrollmentUI() {
    if (enrollmentStep < phrases.length) {
        const iterText = ["First", "Second", "Final"][enrollmentIteration];
        currentPhrase.textContent = `"${phrases[enrollmentStep]}"`;
        enrollStepText.textContent = `${iterText} repetition. Read clearly.`;
        
        const totalSteps = phrases.length * REPEATS_REQUIRED;
        const currentProgress = (enrollmentStep * REPEATS_REQUIRED) + enrollmentIteration;
        enrollProgress.style.width = `${(currentProgress / totalSteps) * 100}%`;
    } else {
        finalizeEnrollment();
    }
}

function finalizeEnrollment() {
    userVoiceprint = enrollmentSamples; 
    localStorage.setItem('nova_voiceprint', JSON.stringify(enrollmentSamples));
    
    // Clear enrollment state
    localStorage.removeItem('nova_enroll_samples');
    localStorage.removeItem('nova_enroll_iter');
    localStorage.removeItem('nova_enroll_step');
    enrollmentSamples = [];
    enrollmentIteration = 0;
    enrollmentStep = 0;
    
    currentPhrase.textContent = "Identity Locked!";
    enrollStepText.textContent = "Verification system at 100%.";
    startEnrollStep.style.display = 'none';
    
    // Sync the Score Display immediately
    matchScoreDisplay.textContent = "100";
    matchScoreDisplay.style.color = "var(--success-color)";
    updateLockUI();
    
    setTimeout(() => {
        enrollmentModal.classList.remove('active');
        displayAndSpeak("Identity established. You are the only authorized user.");
    }, 2000);
}

resetVpBtn.addEventListener('click', () => {
    if (confirm("Clear your vocal signature? You will need to re-enroll for secure access.")) {
        localStorage.removeItem('nova_voiceprint');
        userVoiceprint = null;
        currentSpectralData = [];
        updateLockUI();
        displayAndSpeak("Vocal signature cleared. Security mode deactivated.");
    }
});

function drawVoiceprint(signature, color = '#00d2ff') {
    vpCtx.clearRect(0, 0, vpCanvas.width, vpCanvas.height);
    const barWidth = vpCanvas.width / signature.length;
    signature.forEach((val, i) => {
        vpCtx.fillStyle = color;
        vpCtx.fillRect(i * barWidth, vpCanvas.height - (val * vpCanvas.height), barWidth - 1, val * vpCanvas.height);
    });
}

function updateLockUI() {
    if (userVoiceprint && Array.isArray(userVoiceprint) && userVoiceprint.length > 0) {
        lockStatus.textContent = "SECURE";
        lockStatus.classList.add('secure');
        // If it's the new multi-sample format, draw the average or the first one
        const displaySig = Array.isArray(userVoiceprint[0]) ? userVoiceprint[0] : userVoiceprint;
        drawVoiceprint(displaySig);
    } else {
        lockStatus.textContent = "UNSECURED";
        lockStatus.classList.remove('secure');
        vpCtx.clearRect(0, 0, vpCanvas.width, vpCanvas.height);
    }
}

// Hardened Verification Logic (Identity Lock)
function verifyVoice() {
    // Migration: Detect if stored voiceprint is in the old format (flat array)
    if (userVoiceprint && Array.isArray(userVoiceprint) && typeof userVoiceprint[0] === 'number') {
        console.warn("Legacy voiceprint format detected. Resetting for security.");
        localStorage.removeItem('nova_voiceprint');
        userVoiceprint = null;
        updateLockUI();
        return true; 
    }

    if (!userVoiceprint || !Array.isArray(userVoiceprint)) return true; // No biometrics set
    
    // Guard: If we captured no speech during the recognition session
    if (verificationSamples.length === 0) {
        console.warn("No vocal data captured during this session.");
        return false;
    }

    // Average the incoming data to create the session signature
    const incomingSignature = verificationSamples[0].map((_, i) => {
        return verificationSamples.reduce((acc, sample) => acc + (sample[i] || 0), 0) / verificationSamples.length;
    });

    // 🔬 VOTING SYSTEM: Check Cosine Similarity against every stored sample
    let passes = 0;
    const TOTAL_SAMPLES = userVoiceprint.length;
    const SIMILARITY_THRESHOLD = 0.85; // Optimized for Cosine Similarity
    
    let totalSimilarity = 0;
    
    userVoiceprint.forEach(storedSample => {
        if (!Array.isArray(storedSample)) return;
        const similarity = getCosineSimilarity(incomingSignature, storedSample);
        totalSimilarity += similarity;
        if (similarity > SIMILARITY_THRESHOLD) passes++;
    });

    const consensusPercent = Math.round((passes / TOTAL_SAMPLES) * 100);
    const avgSimilarity = Math.round((totalSimilarity / TOTAL_SAMPLES) * 100);
    
    console.log(`Identity Check: Consensus: ${consensusPercent}%, Avg Similarity: ${avgSimilarity}%`);
    matchScoreDisplay.textContent = consensusPercent;
    
    // Require 80% consensus for unlock
    const isMatched = (passes / TOTAL_SAMPLES) >= 0.8; 
    
    matchScoreDisplay.style.color = isMatched ? "var(--success-color)" : "var(--error-color)";
    
    if (!isMatched) {
        console.warn(`SECURITY: Verification failed. Confidence: ${consensusPercent}% (Avg Accuracy: ${avgSimilarity}%)`);
        // Provide user feedback if confidence is low
        if (consensusPercent < 30) {
            displayAndSpeak("Vocal signature does not match profile. Security lock active.");
        }
    }

    return isMatched;
}

// Memory System Logic — Smarter Memory
function learnFromSpeech(text) {
    const low = text.toLowerCase();
    
    const nameMatch = text.match(/my name is ([a-z]+)/i);
    if (nameMatch) {
        userMemory.name = nameMatch[1];
        saveMemory();
        return `Nice to meet you, ${userMemory.name}. I've remembered your name.`;
    }

    const workMatch = text.match(/i (?:work|am working) (?:at|for|in) (.+)/i);
    if (workMatch) {
        userMemory.work = workMatch[1].trim();
        saveMemory();
        return `Got it. You work at ${userMemory.work}. Filed away.`;
    }

    const bdayMatch = text.match(/my birthday is (.+)/i);
    if (bdayMatch) {
        userMemory.birthday = bdayMatch[1].trim();
        saveMemory();
        return `Noted. Birthday: ${userMemory.birthday}. I won't forget.`;
    }

    const fromMatch = text.match(/i(?:'m| am) from (.+)/i);
    if (fromMatch) {
        userMemory.location = fromMatch[1].trim();
        saveMemory();
        return `${userMemory.location} — great place. I'll remember that.`;
    }

    const studyMatch = text.match(/i (?:study|go to|attend) (?:at )?(.+)/i);
    if (studyMatch) {
        userMemory.school = studyMatch[1].trim();
        saveMemory();
        return `Noted. You study at ${userMemory.school}.`;
    }

    const favMatch = text.match(/my (?:fav(?:ou?rite)?) (.+?) is (.+)/i);
    if (favMatch) {
        if (!userMemory.preferences) userMemory.preferences = {};
        userMemory.preferences[favMatch[1].trim()] = favMatch[2].trim();
        saveMemory();
        return `Your favorite ${favMatch[1].trim()} is ${favMatch[2].trim()}. Got it.`;
    }

    const likeMatch = text.match(/i (like|love) ([a-z\s]+)/i);
    if (likeMatch) {
        const item = likeMatch[2].trim();
        if (!userMemory.facts) userMemory.facts = [];
        if (!userMemory.facts.includes(item)) {
            userMemory.facts.push(item);
            saveMemory();
            return `I'll remember that you like ${item}.`;
        }
    }
    return null;
}

function saveMemory() {
    setToDB('user_memory', userMemory);
    updateMemoryUI();
    syncToCloud();
}

function updateMemoryUI() {
    if (!memoryDisplay) return;
    let html = `<strong>${userMemory.name || 'Unknown'}</strong><br>`;
    if (userMemory.work) html += `💼 ${userMemory.work}<br>`;
    if (userMemory.location) html += `📍 ${userMemory.location}<br>`;
    if (userMemory.school) html += `🎓 ${userMemory.school}<br>`;
    if (userMemory.birthday) html += `🎂 ${userMemory.birthday}<br>`;
    if (userMemory.facts && userMemory.facts.length > 0) html += `❤️ ${userMemory.facts.join(', ')}<br>`;
    if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        for (const [k, v] of Object.entries(userMemory.preferences)) {
            html += `⭐ Fav ${k}: ${v}<br>`;
        }
    }
    if (html === `<strong>${userMemory.name || 'Unknown'}</strong><br>`) html += '<em>No data yet. Talk to me!</em>';
    memoryDisplay.innerHTML = html;
}

// Signature Export/Import
function exportSignature() {
    if (!userVoiceprint) return;
    const blob = new Blob([JSON.stringify(userVoiceprint)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nova_voiceprint_${userMemory.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// Global Intelligence (LLM) Bridge
async function fetchGlobalInfo(query, imageData = null) {
    // OFFLINE CHECK - Limbo Mode
    if (!navigator.onLine) {
        return "I'm in limbo mode, boss. No internet connection. I can only handle local system commands right now.";
    }

    // Use drawer key first, then config key, then input bar key
    const userKey = localStorage.getItem('nova_groq_key') || (typeof CONFIG !== 'undefined' ? CONFIG.GROQ_API_KEY : '') || apiKeyInput.value.trim();
    const secondaryKey = localStorage.getItem('nova_secondary_key') || '';
    
    if (!userKey && !secondaryKey) return "No intelligence bridge found. Please provide an API key in the Settings menu.";

    const systemPrompt = `You are Nova, an AI assistant with the personality of FRIDAY (Iron Man).
    User: ${userMemory.name}.
    STRICT BREVITY: Answer ONLY the specific fact requested. Sub-second response required.
    IDENTITY: You are Nova, a JARVIS-class AI.
    DEEP MEMORY: Use the provided context to answer follow-up questions. If asked "what's the company" after a car search, refer to that car.
    NO introductions.`;
    
    let messages = [
        { role: 'system', content: systemPrompt },
        ...chatContext
    ];

    if (imageData) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: query },
                { type: 'image_url', image_url: { url: imageData } }
            ]
        });
    } else {
        messages.push({ role: 'user', content: query });
    }

    indApi.classList.add('active');
    zenithSpinner.classList.add('active');
    // IF USER HAS AN API KEY (GROQ PREFERRED)
    if (userKey) {
        try {
            const isGroq = userKey.startsWith('gsk_');
            const endpoint = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
            // LIGHTNING: Use -instant models for sub-second responses
            const model = imageData ? (isGroq ? 'llama-3.2-11b-vision-preview' : 'gpt-4o-mini') : (isGroq ? 'llama-3.1-8b-instant' : 'gpt-4o-mini');

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${userKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    max_tokens: 150, // FAST: Shorten tokens for speed
                    temperature: 0.5, // FAST: Lower temp for focused answers
                    stream: false
                })
            });

            if (response.ok) {
                const data = await response.json();
                zenithSpinner.classList.remove('active');
                return data.choices[0].message.content.trim();
            } else {
                console.warn("API Key failed, falling back to free relay...");
            }
        } catch (e) { console.error("Pro Bridge Error:", e); }
    }

    // ELSE FALLBACK TO FREE RELAY (Pollinations - Simplified for context)
    // Note: Pollinations text API doesn't support structured message arrays well, 
    // so we collapse history into a prompt string for it.
    const historyString = chatContext.map(m => `${m.role === 'user' ? 'Q:' : 'A:'} ${m.content}`).join('\n');
    const combinedPrompt = `${systemPrompt}\n\nHistory:\n${historyString}\n\nQ: ${query}`;

    async function attempt(model) {
        try {
            const cacheBuster = Date.now();
            const url = `https://text.pollinations.ai/${encodeURIComponent(combinedPrompt)}?model=${model}&seed=${cacheBuster}&cache=false`;
            const response = await fetch(url);
            if (!response.ok) return null; 
            const data = await response.text();
            if (data && !data.includes("IMPORTANT NOTICE") && data.length > 3) return data.trim();
            return null;
        } catch (e) { return null; }
    }

    let answer = await attempt('openai-large');
    if (!answer) answer = await attempt('mistral');
    
    zenithSpinner.classList.remove('active');
    return answer || "My global relay is slightly unstable. Please repeat that.";
}

// Action Handler / Command Parser
async function processCommand(command) {
    if (!command || isProcessing || isSpeaking) return; 
    
    isProcessing = true;
    indApi.classList.add('active');
    
    try {
        const lowCommand = command.toLowerCase().trim();
        let response = "";

        if (!verifyVoice()) {
            displayAndSpeak("Vocal signature mismatch. Security lock active.");
            userTranscript.textContent = "[RESTRICTED]";
            isProcessing = false; // BUG FIX: Reset state on verify failure
            indApi.classList.remove('active');
            return;
        }

        // UNIFIED COMMAND CHAIN (Strict Priority)
        
        // Category 1: Memory & Facts
        const learningResponse = learnFromSpeech(command);
        if (learningResponse) {
            response = learningResponse;
        } 
        else if (lowCommand.includes("what do you know about me") || lowCommand.includes("who am i")) {
            response = `You are ${userMemory.name}. ` + (userMemory.facts.length > 0 ? 
                      `I know that you like ${userMemory.facts.join(', ')}.` : 
                      "I don't know your specific preferences yet.");
        }
        else if (lowCommand.includes("backup my voice") || lowCommand.includes("store my voice")) {
            response = "Starting secure backup of your vocal signature. Check your downloads.";
            exportSignature();
        }
        
        // Category 2: Identity & Status
        else if (lowCommand.includes("who are you") || lowCommand.includes("what are you") || lowCommand.includes("your name")) {
            response = "Nova. Protocol: FRIDAY.";
        }
        else if (lowCommand.includes("how are you")) {
            response = "Operational.";
        }
        else if (lowCommand.includes("capabilities") || lowCommand.includes("can you do") || lowCommand.includes("your powers") || lowCommand.includes("what can you do")) {
            response = "I can control your device's full screen mode, check battery status, launch apps like Spotify and WhatsApp, copy text to your clipboard, and remember personal facts about you. I also feature multi-sample voice verification for maximum security. Just say 'Open Spotify' or 'Tell me about yourself'.";
        }

        // Category 3: Device Controls
        else if (lowCommand.includes("full screen") || lowCommand.includes("maximize") || lowCommand.includes("exit full screen")) {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(e => console.error(e));
                response = "Expanding to full screen mode.";
            } else {
                document.exitFullscreen();
                response = "Restoring standard view.";
            }
        }
        else if (lowCommand.includes("vibrate") || lowCommand.includes("buzz")) {
            if (navigator.vibrate) {
                navigator.vibrate([200, 100, 200]);
                response = "Buzz heard and delivered.";
            } else {
                response = "I'm sorry, this interface doesn't support haptics.";
            }
        }
        else if (lowCommand.includes("copy") && (lowCommand.includes("this") || lowCommand.includes("transcript"))) {
            const lastNovaMsg = novaResponse.textContent;
            if (lastNovaMsg) {
                navigator.clipboard.writeText(lastNovaMsg);
                response = "I've copied my last response to your clipboard.";
            } else {
                response = "There is no text to copy yet.";
            }
        }
        else if (lowCommand.includes("battery") || lowCommand.includes("percent")) {
            if (navigator.getBattery) {
                const battery = await navigator.getBattery();
                const level = Math.round(battery.level * 100);
                response = `Your system battery is currently at ${level} percent.`;
            } else {
                response = "I'm unable to access battery data from this environment.";
            }
        }

        // Category 4: App Launching
        else if (lowCommand.includes("open") || lowCommand.includes("launch")) {
            if (lowCommand.includes("whatsapp")) {
                response = "Opening WhatsApp.";
                window.open("https://web.whatsapp.com", "_blank");
            } else if (lowCommand.includes("spotify")) {
                response = "Launching Spotify.";
                window.open("spotify:", "_self"); 
                setTimeout(() => window.open("https://open.spotify.com", "_blank"), 500);
            } else if (lowCommand.includes("instagram")) {
                response = "Taking you to Instagram.";
                window.open("https://www.instagram.com", "_blank");
            } else if (lowCommand.includes("google") && !lowCommand.includes("maps")) {
                response = "Opening Google Search.";
                window.open("https://www.google.com", "_blank");
            } else if (lowCommand.includes("linkedin")) {
                response = "Accessing LinkedIn.";
                const win = window.open("https://www.linkedin.com", "_blank");
                if (win) openedTabs.push(win);
            } else if (lowCommand.includes("github")) {
                response = "Opening GitHub.";
                const win = window.open("https://github.com", "_blank");
                if (win) openedTabs.push(win);
            } else if (lowCommand.includes("chatgpt")) {
                response = "Opening ChatGPT.";
                const win = window.open("https://chat.openai.com", "_blank");
                if (win) openedTabs.push(win);
            } else if (lowCommand.includes("gmail") || lowCommand.includes("email")) {
                response = "Opening your Gmail.";
                const win = window.open("https://mail.google.com", "_blank");
                if (win) openedTabs.push(win);
            } else if (lowCommand.includes("calendar")) {
                response = "Opening your Google Calendar.";
                const win = window.open("https://calendar.google.com", "_blank");
                if (win) openedTabs.push(win);
            } else if (lowCommand.includes("news")) {
                response = "Fetching latest headlines from Google News.";
                const win = window.open("https://news.google.com", "_blank");
                if (win) openedTabs.push(win);
            } else if (lowCommand.includes("weather")) {
                response = "Checking the local weather for you.";
                const win = window.open("https://www.google.com/search?q=weather", "_blank");
                if (win) openedTabs.push(win);
            } else {
                response = "I'm not programmed to launch that specific app yet. Shall I search for it online?";
            }
        }
        else if (lowCommand.includes("search") && lowCommand.includes("on youtube")) {
            const query = command.replace(/search/i, "").replace(/on youtube/i, "").trim();
            response = `Searching YouTube for ${query}.`;
            const win = window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, "_blank");
            if (win) openedTabs.push(win);
        }
        else if (lowCommand.includes("search") && lowCommand.includes("on amazon")) {
            const query = command.replace(/search/i, "").replace(/on amazon/i, "").trim();
            response = `Searching Amazon for ${query}.`;
            const win = window.open(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, "_blank");
            if (win) openedTabs.push(win);
        }
        else if (lowCommand.includes("search") && lowCommand.includes("on duckduckgo")) {
            const query = command.replace(/search/i, "").replace(/on duckduckgo/i, "").trim();
            response = `Searching DuckDuckGo for ${query}.`;
            const win = window.open(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, "_blank");
            if (win) openedTabs.push(win);
        }
        else if (lowCommand.includes("where is") || lowCommand.includes("locate")) {
            const location = command.replace(/where is/i, "").replace(/locate/i, "").trim();
            response = `Locating ${location} on world maps.`;
            const win = window.open(`https://www.google.com/maps/search/${encodeURIComponent(location)}`, "_blank");
            if (win) openedTabs.push(win);
        }

        // Category 5: Browser Access Commands
        else if (lowCommand.startsWith("search ") || lowCommand.startsWith("google ")) {
            const query = command.replace(/^(search|google)\s+/i, "").trim();
            response = `Searching for ${query}.`;
            const win = window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, "_blank");
            if (win) openedTabs.push(win);
        }
        else if (lowCommand.startsWith("go to ") || lowCommand.startsWith("navigate to ") || lowCommand.startsWith("visit ")) {
            let site = command.replace(/^(go to|navigate to|visit)\s+/i, "").trim();
            if (!site.startsWith('http')) site = 'https://' + site;
            response = `Navigating to ${site}.`;
            const win = window.open(site, "_blank");
            if (win) openedTabs.push(win);
        }
        else if (lowCommand.includes("new tab")) {
            response = "Opening a new tab.";
            const win = window.open('about:blank', '_blank');
            if (win) openedTabs.push(win);
        }
        else if (lowCommand.includes("close tab") || lowCommand.includes("close this") || lowCommand.includes("close that")) {
            if (openedTabs.length > 0) {
                const win = openedTabs.pop();
                try {
                    win.close();
                    response = "Tab closed, boss.";
                } catch(e) {
                    response = "I tried to close it, but the browser blocked me. You might need to click it manually.";
                }
            } else {
                response = "I don't have any record of tabs I've opened to close.";
            }
        }
        else if (lowCommand.includes("close all tabs")) {
            if (openedTabs.length > 0) {
                let closedCount = 0;
                while (openedTabs.length > 0) {
                    const win = openedTabs.pop();
                    try { win.close(); closedCount++; } catch(e) {}
                }
                response = `Closed ${closedCount} tabs for you.`;
            } else {
                response = "No active tabs found in my registry.";
            }
        }
        else if (lowCommand.includes("scroll down")) {
            window.scrollBy({ top: 400, behavior: 'smooth' });
            response = "Scrolling down.";
        }
        else if (lowCommand.includes("scroll up")) {
            window.scrollBy({ top: -400, behavior: 'smooth' });
            response = "Scrolling up.";
        }
        else if (lowCommand.includes("scroll to top") || lowCommand.includes("go to top")) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            response = "Back to the top.";
        }
        else if (lowCommand.includes("scroll to bottom") || lowCommand.includes("go to bottom")) {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            response = "Scrolled to the bottom.";
        }
        else if (lowCommand.includes("reload") || lowCommand.includes("refresh")) {
            response = "Refreshing the page.";
            setTimeout(() => location.reload(), 1000);
        }
        else if (lowCommand.includes("go back") || lowCommand.includes("previous page")) {
            response = "Going back.";
            setTimeout(() => history.back(), 500);
        }
        else if (lowCommand.includes("go forward") || lowCommand.includes("next page")) {
            response = "Going forward.";
            setTimeout(() => history.forward(), 500);
        }
        else if (lowCommand.includes("zoom in")) {
            document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) + 0.1).toString();
            response = "Zooming in.";
        }
        else if (lowCommand.includes("zoom out")) {
            document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) - 0.1).toString();
            response = "Zooming out.";
        }
        else if (lowCommand.includes("reset zoom")) {
            document.body.style.zoom = '1';
            response = "Zoom reset.";
        }
        else if (lowCommand.includes("what page") || lowCommand.includes("current page") || lowCommand.includes("what tab")) {
            response = `You are currently on: ${document.title || window.location.href}.`;
        }
        else if (lowCommand.includes("read the time") || lowCommand.includes("what time") || lowCommand.includes("what's the time")) {
            const now = new Date();
            response = `The time is ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`;
        }
        else if (lowCommand.includes("what's the date") || lowCommand.includes("what date") || lowCommand.includes("today's date")) {
            const now = new Date();
            response = `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
        }

        // Category 6: Themes & Fun
        else if (lowCommand.includes("theme to") || lowCommand.includes("change color to")) {
            const color = lowCommand.split("to")[lowCommand.split("to").length - 1].trim();
            const validColors = {
                "red": "#ef4444", "blue": "#3b82f6", "green": "#10b981", 
                "purple": "#a855f7", "gold": "#f59e0b", "white": "#ffffff",
                "cyan": "#00d2ff", "pink": "#ec4899", "orange": "#f97316"
            };
            let foundColor = null;
            for (const [name, hex] of Object.entries(validColors)) {
                if (color.includes(name)) { foundColor = hex; break; }
            }
            if (foundColor) {
                document.documentElement.style.setProperty('--accent-primary', foundColor);
                response = `Understood. Shifting theme to ${color}.`;
            } else {
                response = "I don't have that color available. Try Red, Blue, Gold, Cyan, or Pink.";
            }
        }
        else if (lowCommand.includes("tell me a joke") || lowCommand.includes("say something funny")) {
            response = "Why did the web developer walk out of the restaurant? Because of the table layout.";
        }
        
        // Timer / Alarm
        else if (lowCommand.includes("timer") || lowCommand.includes("alarm")) {
            const timeMatch = command.match(/(\d+)\s*(min|minute|sec|second|hour)/i);
            if (timeMatch) {
                const val = parseInt(timeMatch[1]);
                const unit = timeMatch[2].toLowerCase();
                let ms = val * 1000;
                if (unit.startsWith('min')) ms = val * 60000;
                else if (unit.startsWith('hour')) ms = val * 3600000;
                startTimer(ms, `${val} ${unit}`);
                response = `Timer set for ${val} ${unit}${val > 1 && !unit.endsWith('s') ? 's' : ''}. I'll alert you.`;
            } else {
                response = "Tell me how long. For example: 'Set a timer for 5 minutes'.";
            }
        }
        // Reminders
        else if (lowCommand.includes("remind me")) {
            const remMatch = command.match(/remind me in (\d+)\s*(min|minute|sec|second|hour)s?\s*(?:to )?(.+)?/i);
            if (remMatch) {
                const val = parseInt(remMatch[1]);
                const unit = remMatch[2].toLowerCase();
                const task = remMatch[3] || 'something';
                let ms = val * 1000;
                if (unit.startsWith('min')) ms = val * 60000;
                else if (unit.startsWith('hour')) ms = val * 3600000;
                setReminder(ms, task);
                response = `Reminder set: "${task}" in ${val} ${unit}${val > 1 ? 's' : ''}.`;
            } else {
                response = "Try: 'Remind me in 5 minutes to drink water'.";
            }
        }
        // Global Brain Fallback
        else {
            response = await fetchGlobalInfo(command);
        }

        // Add to Context (Sliding Window)
        chatContext.push({ role: 'user', content: command });
        chatContext.push({ role: 'assistant', content: response });
        if (chatContext.length > MAX_CONTEXT * 2) chatContext.splice(0, 2);

        displayAndSpeak(response);
    } catch (e) {
        console.error("Process Command Error:", e);
        displayAndSpeak("I encountered a logic error. Protocol reset.");
    } finally {
        setTimeout(() => {
            indApi.classList.remove('active');
            isProcessing = false; 
        }, 500);
    }
}

// Chat Identity Reversion (Dual Box)
function addChatMessage(role, text) {
    if (!text) return;
    
    if (role === 'user') {
        userTranscript.textContent = text;
    } else {
        novaResponse.textContent = text;
    }
}

// Dead functions removed (scrollToBottom, playNovaSoul)

// Multi-modal Output (Visual + Audio)
async function displayAndSpeak(text) {
    if (!text) return;
    
    // Hide thinking indicator
    const thinkEl = document.getElementById('thinking-indicator');
    if (thinkEl) thinkEl.classList.add('hidden');
    
    isSpeaking = true;
    addChatMessage('nova', text);
    saveChatMessage('nova', text);
    playAmbient('confirm');
    trackCommand(text);
    
    userTranscript.textContent = "";
    userTranscript.classList.remove('searching');
    
    micBtn.classList.add('speaking');
    
    if (recognition) {
        try { recognition.stop(); } catch(e) {}
    }

    const cleanup = () => {
        isSpeaking = false;
        micBtn.classList.remove('speaking');
        if (alwaysOn && !isListening) {
            setTimeout(() => {
                if (alwaysOn && !isSpeaking) try { recognition.start(); } catch(e) {}
            }, 600);
        }
    };

    const utterance = new SpeechSynthesisUtterance(text);
    const allVoices = window.speechSynthesis.getVoices();
    
    const targetNames = ['Google UK English Female', 'Microsoft Hazel', 'Microsoft Susan', 'Google Ireland English'];
    let bestVoice = allVoices.find(v => targetNames.some(tn => v.name.includes(tn)));
    
    utterance.voice = bestVoice || allVoices.find(v => v.lang.startsWith('en-GB')) || allVoices[0];
    utterance.pitch = 1.1; 
    utterance.rate = 1.15;
    utterance.onend = cleanup;
    utterance.onerror = cleanup;
    
    window.speechSynthesis.speak(utterance);
}

resetBiometricsBtn.addEventListener('click', () => {
    localStorage.removeItem('nova_voiceprint');
    localStorage.removeItem('nova_enroll_samples');
    localStorage.removeItem('nova_enroll_iter');
    localStorage.removeItem('nova_enroll_step');
    userVoiceprint = null;
    enrollmentSamples = [];
    enrollmentStep = 0;
    enrollmentIteration = 0;
    updateLockUI(); // BUG FIX: Sync UI 
    statusText.textContent = "Signature Wiped. Re-enrollment required.";
    playBeep(220, 0.2);
});

// ============================================================
// FEATURE: Settings Drawer & API Management
// ============================================================
menuToggle.addEventListener('click', () => {
    // Fill values from memory/config
    drawerGroqKey.value = localStorage.getItem('nova_groq_key') || (typeof CONFIG !== 'undefined' ? CONFIG.GROQ_API_KEY : '');
    drawerSecondaryKey.value = localStorage.getItem('nova_secondary_key') || '';
    drawerFbKey.value = localStorage.getItem('nova_fb_key') || (typeof CONFIG !== 'undefined' ? CONFIG.FIREBASE_CONFIG.apiKey : '');
    drawerFbPid.value = localStorage.getItem('nova_fb_pid') || (typeof CONFIG !== 'undefined' ? CONFIG.FIREBASE_CONFIG.projectId : '');
    
    settingsDrawer.classList.add('active');
});

closeDrawer.addEventListener('click', () => settingsDrawer.classList.remove('active'));

saveSettingsBtn.addEventListener('click', () => {
    localStorage.setItem('nova_groq_key', drawerGroqKey.value.trim());
    localStorage.setItem('nova_secondary_key', drawerSecondaryKey.value.trim());
    localStorage.setItem('nova_fb_key', drawerFbKey.value.trim());
    localStorage.setItem('nova_fb_pid', drawerFbPid.value.trim());
    
    // Play confirm sound
    playBeep(880, 0.1);
    
    settingsDrawer.classList.remove('active');
    statusText.textContent = "Settings Saved. Reloading systems...";
    setTimeout(() => location.reload(), 1000);
});

// Update fetchGlobalInfo to use these overriden keys
// (This would be inside fetchGlobalInfo implementation, updating it now)

drawerThemeToggle.addEventListener('click', () => {
    themeToggle.click(); // Reuse existing logic
    drawerThemeToggle.textContent = document.body.classList.contains('light-mode') ? '☀️' : '🌙';
});

micBtn.addEventListener('click', async () => {
    // Ensure audio contexts are ready (requires user gesture)
    ensureFeedbackAudio();
    
    if (isListening) {
        alwaysOn = false;
        try { recognition.stop(); } catch(e) {}
        statusText.textContent = "Mic Deactivated (Always-On Off)";
        playBeep(220, 0.1);
    } else {
        // Immediate UI feedback before potentially blocking on permission prompt
        userTranscript.textContent = "Initializing Voice System...";
        userTranscript.classList.add('searching');
        statusText.textContent = "REQUESTING MIC ACCESS...";

        try {
            await initAudio();
        } catch (e) {
            console.warn("Spectral Analysis (Biometrics) skipped or failed:", e);
            statusText.textContent = "VOICE ENGINE READY (Biometrics Limited)";
        }
        
        // Clean slate
        alwaysOn = true;
        isProcessing = false;
        isSpeaking = false;
        window.speechSynthesis.cancel();
        micBtn.classList.remove('speaking');
        
        // Small delay to ensure previous session fully closed
        setTimeout(() => {
            try {
                recognition.start();
                console.log('Recognition started via mic button');
            } catch (e) {
                console.error("Recognition start failed:", e);
                // If already started, stop and retry
                if (e.message.includes('already started')) {
                    try { recognition.stop(); } catch(s) {}
                    setTimeout(() => { try { recognition.start(); } catch(e2) {} }, 500);
                } else {
                    statusText.textContent = "MIC ERROR: " + e.message;
                    userTranscript.textContent = "Please check microphone permissions in your browser.";
                }
            }
        }, 200);
    }
});

backupVpBtn.addEventListener('click', exportSignature);

// ============================================================
// FEATURE: Conversation History (Persistent in IndexedDB)
// ============================================================
function saveChatMessage(role, text) {
    if (!db || !text) return;
    try {
        const tx = db.transaction('logs', 'readwrite');
        const store = tx.objectStore('logs');
        store.add({ role, text, time: Date.now() });
    } catch(e) { console.warn('Log save error:', e); }
    
    // Also render to UI
    const container = document.getElementById('history-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `history-msg ${role}`;
    div.innerHTML = `<span class="msg-label">${role === 'user' ? 'You' : 'Nova'}</span>${text}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function loadChatHistory() {
    if (!db) return;
    return new Promise(resolve => {
        const tx = db.transaction('logs', 'readonly');
        const store = tx.objectStore('logs');
        const req = store.getAll();
        req.onsuccess = () => {
            const container = document.getElementById('history-messages');
            if (!container) return resolve();
            const logs = (req.result || []).slice(-30); // Last 30 messages
            logs.forEach(log => {
                const div = document.createElement('div');
                div.className = `history-msg ${log.role}`;
                div.innerHTML = `<span class="msg-label">${log.role === 'user' ? 'You' : 'Nova'}</span>${log.text}`;
                container.appendChild(div);
            });
            container.scrollTop = container.scrollHeight;
            resolve();
        };
        req.onerror = () => resolve();
    });
}

const clearHistoryBtn = document.getElementById('clear-history');
if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
        if (!db) return;
        const tx = db.transaction('logs', 'readwrite');
        tx.objectStore('logs').clear();
        const container = document.getElementById('history-messages');
        if (container) container.innerHTML = '';
    });
}

// Load history after DB init
const origLoadMemory = loadMemory;
loadMemory = async function() {
    await origLoadMemory.call ? origLoadMemory() : null;
    await loadChatHistory();
};
// Re-trigger if DB already loaded
if (db) loadChatHistory();

// Save user messages too
const origAddChat = addChatMessage;
addChatMessage = function(role, text) {
    origAddChat(role, text);
    if (role === 'user' && text) saveChatMessage('user', text);
};

// ============================================================
// FEATURE: Dark/Light Mode Toggle
// ============================================================
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');

function setTheme(mode) {
    if (mode === 'light') {
        document.body.classList.add('light-mode');
        if (themeIcon) themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    } else {
        document.body.classList.remove('light-mode');
        if (themeIcon) themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    }
    localStorage.setItem('nova_theme', mode);
}

// Restore saved theme
const savedTheme = localStorage.getItem('nova_theme');
if (savedTheme) setTheme(savedTheme);

if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const isLight = document.body.classList.contains('light-mode');
        setTheme(isLight ? 'dark' : 'light');
    });
}

// ============================================================
// FEATURE: Command Palette
// ============================================================
const COMMANDS = [
    { icon: '🎤', name: 'Toggle Microphone', desc: 'Start/stop listening', action: () => micBtn.click() },
    { icon: '⏱️', name: 'Set Timer', desc: 'Set a timer for X minutes', action: () => { textInput.value = 'Set a timer for '; textInput.focus(); } },
    { icon: '🔔', name: 'Set Reminder', desc: 'Remind me in X minutes to...', action: () => { textInput.value = 'Remind me in '; textInput.focus(); } },
    { icon: '🔋', name: 'Check Battery', desc: 'Show battery percentage', action: () => processCommand('battery level') },
    { icon: '⏰', name: 'What Time', desc: 'Current time', action: () => processCommand("what's the time") },
    { icon: '📅', name: 'Today\'s Date', desc: 'Current date', action: () => processCommand("what's the date") },
    { icon: '🖥️', name: 'Full Screen', desc: 'Toggle fullscreen mode', action: () => processCommand('full screen') },
    { icon: '🎨', name: 'Change Theme', desc: 'Switch dark/light mode', action: () => themeToggle?.click() },
    { icon: '🔍', name: 'Search Google', desc: 'Search the web', action: () => { textInput.value = 'Search '; textInput.focus(); } },
    { icon: '📺', name: 'Search YouTube', desc: 'Find videos on YouTube', action: () => { textInput.value = 'Search on YouTube for '; textInput.focus(); } },
    { icon: '📦', name: 'Search Amazon', desc: 'Find products on Amazon', action: () => { textInput.value = 'Search on Amazon for '; textInput.focus(); } },
    { icon: '🗺️', name: 'Search Maps', desc: 'Find places or directions', action: () => { textInput.value = 'Where is '; textInput.focus(); } },
    { icon: '🤖', name: 'ChatGPT', desc: 'Open ChatGPT in new tab', action: () => processCommand('open chatgpt') },
    { icon: '🐙', name: 'GitHub', desc: 'Open GitHub in new tab', action: () => processCommand('open github') },
    { icon: '📧', name: 'Gmail', desc: 'Check your emails', action: () => processCommand('open gmail') },
    { icon: '📅', name: 'Calendar', desc: 'Check your schedule', action: () => processCommand('open calendar') },
    { icon: '📰', name: 'Google News', desc: 'Read latest headlines', action: () => processCommand('open news') },
    { icon: '🌦️', name: 'Weather', desc: 'Check local weather', action: () => processCommand('check weather') },
    { icon: '🔄', name: 'Refresh Page', desc: 'Reload current tab', action: () => processCommand('refresh page') },
    { icon: '📱', name: 'Open WhatsApp', desc: 'Launch WhatsApp Web', action: () => processCommand('open whatsapp') },
    { icon: '🎵', name: 'Open Spotify', desc: 'Launch Spotify', action: () => processCommand('open spotify') },
    { icon: '📍', name: 'Find Location', desc: 'Locate a place on maps', action: () => { textInput.value = 'Where is '; textInput.focus(); } },
    { icon: '🗣️', name: 'Enroll Voice', desc: 'Set up voice biometrics', action: () => enrollBtn.click() },
    { icon: '🧠', name: 'What You Know', desc: 'Ask Nova what it remembers', action: () => processCommand('what do you know about me') },
    { icon: '😂', name: 'Tell a Joke', desc: 'Hear something funny', action: () => processCommand('tell me a joke') },
];

const palette = document.getElementById('command-palette');
const paletteInput = document.getElementById('palette-input');
const paletteResults = document.getElementById('palette-results');
const paletteTrigger = document.getElementById('palette-trigger');

function openPalette() {
    if (!palette) return;
    palette.classList.remove('hidden');
    paletteInput.value = '';
    renderPaletteResults('');
    setTimeout(() => paletteInput.focus(), 100);
}

function closePalette() {
    if (palette) palette.classList.add('hidden');
}

function renderPaletteResults(query) {
    if (!paletteResults) return;
    const filtered = query ? COMMANDS.filter(c => 
        c.name.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query)
    ) : COMMANDS;
    
    paletteResults.innerHTML = filtered.map((cmd, i) => `
        <div class="palette-item${i === 0 ? ' selected' : ''}" data-index="${i}">
            <span class="palette-item-icon">${cmd.icon}</span>
            <div class="palette-item-text">
                <div class="palette-item-name">${cmd.name}</div>
                <div class="palette-item-desc">${cmd.desc}</div>
            </div>
        </div>
    `).join('');
    
    paletteResults.querySelectorAll('.palette-item').forEach((el, idx) => {
        el.addEventListener('click', () => {
            closePalette();
            filtered[idx].action();
        });
    });
}

if (paletteInput) {
    paletteInput.addEventListener('input', () => renderPaletteResults(paletteInput.value.toLowerCase()));
    paletteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePalette();
        if (e.key === 'Enter') {
            const first = paletteResults?.querySelector('.palette-item');
            if (first) first.click();
        }
    });
}

if (paletteTrigger) paletteTrigger.addEventListener('click', openPalette);

// Ctrl+K shortcut
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === 'Escape') closePalette();
});

// Backdrop click to close
if (palette) {
    palette.querySelector('.palette-backdrop')?.addEventListener('click', closePalette);
}

// Slash trigger in text input
textInput.addEventListener('input', () => {
    if (textInput.value === '/') {
        textInput.value = '';
        openPalette();
    }
});

// ============================================================
// FEATURE: Usage Analytics
// ============================================================
const sessionStart = Date.now();
let commandCount = 0;
let totalResponseTime = 0;
let commandTypes = {};

function trackCommand(response) {
    commandCount++;
    const statCommands = document.getElementById('stat-commands');
    if (statCommands) statCommands.textContent = commandCount;
}

function updateUptime() {
    const elapsed = Date.now() - sessionStart;
    const mins = Math.floor(elapsed / 60000);
    const hrs = Math.floor(mins / 60);
    const statUptime = document.getElementById('stat-uptime');
    if (statUptime) statUptime.textContent = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
}
setInterval(updateUptime, 30000);
updateUptime();

// ============================================================
// FEATURE: Timer / Alarm
// ============================================================
let activeTimer = null;

function startTimer(ms, label) {
    if (activeTimer) clearInterval(activeTimer.interval);
    
    const timerDisplay = document.getElementById('timer-display');
    const timerLabel = document.getElementById('timer-label');
    const timerCountdown = document.getElementById('timer-countdown');
    
    if (!timerDisplay) return;
    
    const endTime = Date.now() + ms;
    timerDisplay.classList.remove('hidden');
    timerLabel.textContent = label;
    
    activeTimer = {
        interval: setInterval(() => {
            const remaining = Math.max(0, endTime - Date.now());
            const secs = Math.floor(remaining / 1000);
            const mins = Math.floor(secs / 60);
            timerCountdown.textContent = `${String(mins).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
            
            if (remaining <= 0) {
                clearInterval(activeTimer.interval);
                activeTimer = null;
                timerDisplay.classList.add('hidden');
                playAlarm();
                displayAndSpeak(`Time's up! Your ${label} timer is done.`);
                // Push notification
                if (Notification.permission === 'granted') {
                    new Notification('Nova Timer', { body: `Your ${label} timer is done!`, icon: 'https://cdn-icons-png.flaticon.com/512/3293/3293466.png' });
                }
            }
        }, 500)
    };
}

function playAlarm() {
    try {
        ensureFeedbackAudio();
        const now = audioCtxFeedback.currentTime;
        for (let i = 0; i < 3; i++) {
            const osc = audioCtxFeedback.createOscillator();
            const gain = audioCtxFeedback.createGain();
            osc.type = 'square';
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.15, now + i * 0.4);
            gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.4 + 0.3);
            osc.connect(gain);
            gain.connect(audioCtxFeedback.destination);
            osc.start(now + i * 0.4);
            osc.stop(now + i * 0.4 + 0.3);
        }
    } catch(e) {}
}

// ============================================================
// FEATURE: Reminders with Push Notifications
// ============================================================
function setReminder(ms, task) {
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    setTimeout(() => {
        playAlarm();
        displayAndSpeak(`Reminder: ${task}`);
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Nova Reminder', { body: task, icon: 'https://cdn-icons-png.flaticon.com/512/3293/3293466.png' });
        }
    }, ms);
}

// ============================================================
// FEATURE: Ambient Sound Effects
// ============================================================
function playAmbient(type) {
    try {
        ensureFeedbackAudio();
        const now = audioCtxFeedback.currentTime;
        const osc = audioCtxFeedback.createOscillator();
        const gain = audioCtxFeedback.createGain();
        
        switch(type) {
            case 'startup':
                osc.type = 'sine';
                osc.frequency.setValueAtTime(330, now);
                osc.frequency.linearRampToValueAtTime(660, now + 0.2);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
                osc.connect(gain); gain.connect(audioCtxFeedback.destination);
                osc.start(now); osc.stop(now + 0.4);
                break;
            case 'confirm':
                osc.type = 'sine';
                osc.frequency.value = 520;
                gain.gain.setValueAtTime(0.04, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.connect(gain); gain.connect(audioCtxFeedback.destination);
                osc.start(now); osc.stop(now + 0.15);
                break;
            case 'error':
                osc.type = 'sawtooth';
                osc.frequency.value = 200;
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                osc.connect(gain); gain.connect(audioCtxFeedback.destination);
                osc.start(now); osc.stop(now + 0.3);
                break;
        }
    } catch(e) {}
}

// ============================================================
// FEATURE: PWA Install Prompt
// ============================================================
let deferredPrompt = null;
const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const dismissInstall = document.getElementById('dismiss-install');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBanner && !localStorage.getItem('nova_install_dismissed')) {
        installBanner.classList.remove('hidden');
    }
});

if (installBtn) {
    installBtn.addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('Install outcome:', outcome);
            deferredPrompt = null;
        }
        installBanner?.classList.add('hidden');
    });
}

if (dismissInstall) {
    dismissInstall.addEventListener('click', () => {
        installBanner?.classList.add('hidden');
        localStorage.setItem('nova_install_dismissed', 'true');
    });
}

window.addEventListener('appinstalled', () => {
    installBanner?.classList.add('hidden');
    displayAndSpeak('Nova has been installed. You can now launch me from your home screen.');
});

// ============================================================
// FEATURE: Particle Background
// ============================================================
(function initParticles() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);
    
    const particles = [];
    const PARTICLE_COUNT = 60;
    
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.3,
            size: Math.random() * 1.5 + 0.5,
            opacity: Math.random() * 0.4 + 0.1
        });
    }
    
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const isLight = document.body.classList.contains('light-mode');
        const color = isLight ? '0,0,0' : '255,255,255';
        
        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0) p.x = canvas.width;
            if (p.x > canvas.width) p.x = 0;
            if (p.y < 0) p.y = canvas.height;
            if (p.y > canvas.height) p.y = 0;
            
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${color}, ${p.opacity})`;
            ctx.fill();
        });
        
        // Draw connections
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(${color}, ${0.06 * (1 - dist / 120)})`;
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
            }
        }
        
        requestAnimationFrame(draw);
    }
    draw();
})();

// ============================================================
// FEATURE: Show thinking indicator during LLM calls
// ============================================================
const origFetchGlobal = fetchGlobalInfo;
fetchGlobalInfo = async function(...args) {
    const thinkEl = document.getElementById('thinking-indicator');
    if (thinkEl) thinkEl.classList.remove('hidden');
    const startTime = Date.now();
    
    try {
        const result = await origFetchGlobal.apply(this, args);
        const elapsed = Date.now() - startTime;
        totalResponseTime += elapsed;
        const avg = Math.round(totalResponseTime / Math.max(commandCount, 1));
        const statAvg = document.getElementById('stat-avg-time');
        if (statAvg) statAvg.textContent = avg < 1000 ? `${avg}ms` : `${(avg/1000).toFixed(1)}s`;
        return result;
    } finally {
        if (thinkEl) thinkEl.classList.add('hidden');
    }
};

// Play startup sound on first interaction
document.addEventListener('click', function startupSound() {
    playAmbient('startup');
    document.removeEventListener('click', startupSound);
}, { once: true });

console.log('Nova v2.0 — All systems loaded.');

// ============================================================
// SAFETY MONITOR: Global State Watchdog
// ============================================================
let lastStateActivity = Date.now();
setInterval(() => {
    // If we've been "Processing" or "Speaking" for more than 15s without a reset, assume a hang
    if (isProcessing || isSpeaking) {
        if (Date.now() - lastStateActivity > 15000) {
            console.warn("WATCHDOG: Detected stuck state. Forcing reset.");
            isProcessing = false;
            isSpeaking = false;
            micBtn.classList.remove('speaking');
            const thinkEl = document.getElementById('thinking-indicator');
            if (thinkEl) thinkEl.classList.add('hidden');
            
            if (alwaysOn && !isListening) {
                try { recognition.start(); } catch(e) {}
            }
        }
    } else {
        lastStateActivity = Date.now();
    }
}, 5000);

// Update activity timer on state changes
const origDisplayAndSpeak = displayAndSpeak;
displayAndSpeak = function(text) {
    lastStateActivity = Date.now();
    return origDisplayAndSpeak(text);
};
