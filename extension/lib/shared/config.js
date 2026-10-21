// Fill these in from Firebase console → Project settings → Your apps → Web app.
// This is the ONE place config lives; `npm run sync` copies it into the extension.
export const firebaseConfig = {
  apiKey: "AIzaSyAOBu0laTfaXSMNrQrKNJdLUBrYdsCeNO4",
  authDomain: "checklater-ea1ba.firebaseapp.com",
  projectId: "checklater-ea1ba",
  storageBucket: "checklater-ea1ba.firebasestorage.app",
  messagingSenderId: "4231610246",
  appId: "1:4231610246:web:66d01998d3d7b17d457607",
  measurementId: "G-15K0LD381D"
};

// Where the web app is hosted (Firebase Hosting gives you https://<projectId>.web.app).
export const WEB_APP_URL = 'https://checklater-ea1ba.web.app/';

export const isConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
