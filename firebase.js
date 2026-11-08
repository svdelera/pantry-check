import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const acct = document.getElementById("acct");

function show(html) {
  acct.hidden = false;
  acct.innerHTML = html;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function signedOutView(msg) {
  show(
    '<span>' + (msg ? esc(msg) : "Sign in to sync your list across devices.") + "</span>" +
    '<button type="button" class="btn sm primary" id="signInBtn">Sign in with Google</button>'
  );
  document.getElementById("signInBtn").onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code === "auth/unauthorized-domain") signedOutView("This domain isn't authorized in Firebase (Authentication > Settings > Authorized domains).");
      else if (e.code === "auth/popup-blocked") signedOutView("The sign-in popup was blocked. Allow popups for this page and try again.");
      else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") signedOutView("Sign-in failed: " + (e.code || e.message));
    }
  };
}

function signedInView(user) {
  show(
    "<span>Signed in as " + esc(user.email || user.displayName || "you") + "</span>" +
    '<button type="button" class="btn sm" id="signOutBtn">Sign out</button>'
  );
  document.getElementById("signOutBtn").onclick = async () => {
    window.pantryApp.reset();   // clear this device's copy
    await signOut(auth);
  };
}

onAuthStateChanged(auth, user => {
  if (!user) {
    window.pantryApp.detach();
    signedOutView();
    return;
  }
  signedInView(user);
  // One document per user: users/{uid}/pantry/main (matches the Firestore rules)
  const ref = doc(db, "users", user.uid, "pantry", "main");
  window.pantryApp.attach({
    set: data => setDoc(ref, data),
    onSnapshot: (next, fail) => onSnapshot(ref, { includeMetadataChanges: true }, next, fail)
  });
});