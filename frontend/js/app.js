/**
 * Front-end logic: capture a photo, send it for ingredient detection,
 * show the ingredient list, and fetch/show recipes.
 */
const BACKEND_URL = "https://ingredient-app-backend.onrender.com";

// screen navigation

const screens = {
  scan: document.getElementById("scan-screen"),
  list: document.getElementById("list-screen"),
  recipes: document.getElementById("recipes-screen"),
  detail: document.getElementById("detail-screen"),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add("d-none"));
  screens[name].classList.remove("d-none");
}

// back button fix - push history state so popstate can restore the right screen

function renderState(state) {
  if (!state) {
    // no state, just fall back to the scan screen
    showScreen("scan");
    return;
  }
  showScreen(state.screen);
  if (state.screen === "list") {
    loadIngredientList();
  } else if (state.screen === "detail" && state.recipeId != null) {
    loadRecipeDetail(state.recipeId);
  }
}

function navigateTo(screenName, extraState) {
  history.pushState(Object.assign({ screen: screenName }, extraState), "");
  showScreen(screenName);
}

// tag the initial screen so going back to it still works
history.replaceState({ screen: "scan" }, "");

window.addEventListener("popstate", (event) => {
  renderState(event.state);
});

// camera setup (rear-facing)

const video = document.getElementById("camera-feed");
const canvas = document.getElementById("capture-canvas");
const capturedPreview = document.getElementById("captured-preview");
const detectingBadge = document.getElementById("detecting-badge");
const cameraPlaceholder = document.getElementById("camera-placeholder");
const captureBtn = document.getElementById("capture-btn");
const enableCameraBtn = document.getElementById("enable-camera-btn");

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = stream;
    cameraPlaceholder.classList.add("d-none");
    captureBtn.disabled = false;
  } catch (err) {
    // show a clear message instead of failing silently if permission is denied
    cameraPlaceholder.classList.remove("d-none");
    cameraPlaceholder.querySelector("p").textContent =
      "Camera permission was denied or is unavailable. Enable it in your browser settings and try again.";
    captureBtn.disabled = true;
    console.error("getUserMedia failed:", err);
  }
}

enableCameraBtn.addEventListener("click", startCamera);
// try automatically on load too
startCamera();

// phone photos can be huge, downscale before sending so it uploads/detects faster
const MAX_CAPTURE_DIMENSION = 1024;

function captureFrame() {
  const nativeWidth = video.videoWidth || 720;
  const nativeHeight = video.videoHeight || 960;
  const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(nativeWidth, nativeHeight));
  canvas.width = Math.round(nativeWidth * scale);
  canvas.height = Math.round(nativeHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8); // full data URL, incl. "data:image/jpeg;base64," prefix
}

// api helpers
//
// The session id travels as an X-Session-Id request/response header rather than a
// cookie (see SessionConfig/WebConfig on the back-end), since Safari blocks the
// cross-site cookie the old setup relied on. sessionStorage keeps it for this tab
// only, matching how session data already behaved before this change.

const SESSION_HEADER = "X-Session-Id";
const SESSION_STORAGE_KEY = "sc_session_id";

function getStoredSessionId() {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch (err) {
    return null; // sessionStorage can be unavailable, e.g. in private browsing
  }
}

function storeSessionId(sessionId) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch (err) {
    // nothing we can do if storage is blocked; this request still worked, it just
    // won't be remembered for the next one
  }
}

function withSessionHeader(headers) {
  const sessionId = getStoredSessionId();
  const merged = Object.assign({}, headers);
  if (sessionId) {
    merged[SESSION_HEADER] = sessionId;
  }
  return merged;
}

function captureSessionId(res) {
  const sessionId = res.headers.get(SESSION_HEADER);
  if (sessionId) {
    storeSessionId(sessionId);
  }
  return res;
}

async function apiPost(path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: withSessionHeader({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return captureSessionId(res);
}

async function apiGet(path) {
  const res = await fetch(`${BACKEND_URL}${path}`, { headers: withSessionHeader({}) });
  return captureSessionId(res);
}

async function apiDelete(path) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "DELETE",
    headers: withSessionHeader({}),
  });
  return captureSessionId(res);
}

function showAlert(el, message, variant) {
  el.textContent = message;
  el.className = `alert alert-${variant} mt-2`;
  el.classList.remove("d-none");
}

// scan screen

const scanCountEl = document.getElementById("scan-count");
const scanStatusEl = document.getElementById("scan-status");
let currentIngredientCount = 0;

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = "Detecting...";
  scanStatusEl.classList.add("d-none");

  // show the photo just taken instead of the live feed while detecting
  const dataUrl = captureFrame();
  capturedPreview.src = dataUrl;
  capturedPreview.classList.remove("d-none");
  detectingBadge.classList.remove("d-none");

  try {
    const image = dataUrl.split(",")[1]; // strip the "data:image/jpeg;base64," prefix
    const res = await apiPost("/api/detect-ingredients", { image });

    if (!res.ok) {
      if (res.status === 429) {
        showAlert(
          scanStatusEl,
          "You've used up today's free Gemini scan limit. Please try again later.",
          "danger"
        );
      } else {
        showAlert(scanStatusEl, "Detection failed. Please try again.", "danger");
      }
      return;
    }

    const ingredients = await res.json();
    const newCount = ingredients.length;
    const gained = newCount - currentIngredientCount;
    currentIngredientCount = newCount;
    scanCountEl.textContent = `${currentIngredientCount} ingredient${currentIngredientCount === 1 ? "" : "s"} scanned`;

    if (gained > 0) {
      showAlert(scanStatusEl, `Detected ${gained} new ingredient${gained === 1 ? "" : "s"}.`, "success");
    } else {
      showAlert(scanStatusEl, "No new ingredients detected in that frame - try a clearer angle.", "warning");
    }
  } catch (err) {
    console.error(err);
    showAlert(scanStatusEl, "Could not reach the server. Is the back-end running?", "danger");
  } finally {
    captureBtn.disabled = false;
    captureBtn.textContent = "Capture";
    detectingBadge.classList.add("d-none");
    capturedPreview.classList.add("d-none");
  }
});

document.getElementById("view-list-btn").addEventListener("click", () => {
  navigateTo("list");
  loadIngredientList();
});

// ingredient list screen

const ingredientListEl = document.getElementById("ingredient-list");
const emptyListMessage = document.getElementById("empty-list-message");
const recipesStatusEl = document.getElementById("recipes-status");

async function loadIngredientList() {
  try {
    const res = await apiGet("/api/ingredients");
    const ingredients = await res.json();
    renderIngredientList(ingredients);
    currentIngredientCount = ingredients.length;
    scanCountEl.textContent = `${currentIngredientCount} ingredient${currentIngredientCount === 1 ? "" : "s"} scanned`;
  } catch (err) {
    console.error(err);
  }
}

function renderIngredientList(ingredients) {
  ingredientListEl.innerHTML = "";
  emptyListMessage.classList.toggle("d-none", ingredients.length > 0);

  ingredients.forEach((ingredient) => {
    const li = document.createElement("li");
    li.className = "ingredient-pill";

    const label = document.createElement("span");
    const pct = Math.round(ingredient.confidence * 100);
    label.textContent = `${capitalise(ingredient.name)} (${pct}% accuracy)`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-ingredient-btn";
    removeBtn.setAttribute("aria-label", `Remove ${ingredient.name}`);
    removeBtn.textContent = "✕"; // X
    removeBtn.addEventListener("click", () => removeIngredient(ingredient.name));

    li.appendChild(label);
    li.appendChild(removeBtn);
    ingredientListEl.appendChild(li);
  });
}

async function removeIngredient(name) {
  try {
    const res = await apiDelete(`/api/ingredients/${encodeURIComponent(name)}`);
    const ingredients = await res.json();
    renderIngredientList(ingredients);
    currentIngredientCount = ingredients.length;
    scanCountEl.textContent = `${currentIngredientCount} ingredient${currentIngredientCount === 1 ? "" : "s"} scanned`;
  } catch (err) {
    console.error(err);
  }
}

function capitalise(text) {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

// manually add an ingredient by text

const addIngredientToggleBtn = document.getElementById("add-ingredient-toggle-btn");
const addIngredientForm = document.getElementById("add-ingredient-form");
const addIngredientInput = document.getElementById("add-ingredient-input");
const addIngredientCancelBtn = document.getElementById("add-ingredient-cancel-btn");
const addIngredientStatusEl = document.getElementById("add-ingredient-status");

function openAddIngredientForm() {
  addIngredientToggleBtn.classList.add("d-none");
  addIngredientForm.classList.remove("d-none");
  addIngredientStatusEl.classList.add("d-none");
  addIngredientInput.focus();
}

function closeAddIngredientForm() {
  addIngredientForm.classList.add("d-none");
  addIngredientToggleBtn.classList.remove("d-none");
  addIngredientInput.value = "";
}

addIngredientToggleBtn.addEventListener("click", openAddIngredientForm);

addIngredientCancelBtn.addEventListener("click", () => {
  closeAddIngredientForm();
  addIngredientStatusEl.classList.add("d-none");
});

addIngredientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = addIngredientInput.value.trim();
  if (!name) {
    return;
  }

  try {
    const res = await apiPost("/api/ingredients", { name });
    if (!res.ok) {
      if (res.status === 429) {
        showAlert(
          addIngredientStatusEl,
          "You've used up today's free ingredient lookup limit. Please try again later.",
          "danger"
        );
        return;
      }
      const err = await res.json();
      showAlert(addIngredientStatusEl, err.error || "Could not add that ingredient.", "danger");
      return;
    }
    const ingredients = await res.json();
    renderIngredientList(ingredients);
    currentIngredientCount = ingredients.length;
    scanCountEl.textContent = `${currentIngredientCount} ingredient${currentIngredientCount === 1 ? "" : "s"} scanned`;
    closeAddIngredientForm();
  } catch (err) {
    console.error(err);
    showAlert(addIngredientStatusEl, "Could not reach the server. Is the back-end running?", "danger");
  }
});

document.getElementById("scan-another-btn").addEventListener("click", () => {
  navigateTo("scan");
});

document.getElementById("get-recipes-btn").addEventListener("click", async () => {
  recipesStatusEl.classList.add("d-none");
  try {
    const res = await apiGet("/api/recipes");
    if (!res.ok) {
      if (res.status === 429) {
        showAlert(
          recipesStatusEl,
          "You've used up today's free recipe search limit. Please try again later.",
          "danger"
        );
      } else {
        const err = await res.json();
        showAlert(recipesStatusEl, err.error || "Could not fetch recipes.", "warning");
      }
      return;
    }
    const recipes = await res.json();
    renderRecipes(recipes);
    navigateTo("recipes");
  } catch (err) {
    console.error(err);
    showAlert(recipesStatusEl, "Could not reach the server. Is the back-end running?", "danger");
  }
});

// recipe results screen

const recipeCardsEl = document.getElementById("recipe-cards");

const pantryNoteEl = document.getElementById("pantry-note");

document.getElementById("pantry-note-close").addEventListener("click", () => {
  pantryNoteEl.classList.add("d-none");
});

function renderRecipes(recipes) {
  recipeCardsEl.innerHTML = "";

  if (recipes.length === 0) {
    pantryNoteEl.classList.add("d-none");
    recipeCardsEl.innerHTML = '<p class="text-muted text-center">No matching recipes found.</p>';
    return;
  }

  // shown again on every new search, in case it was dismissed on an earlier one
  pantryNoteEl.classList.remove("d-none");

  recipes.forEach((recipe) => {
    const card = document.createElement("div");
    card.className = "recipe-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.addEventListener("click", () => openRecipeDetail(recipe.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openRecipeDetail(recipe.id);
    });

    const img = document.createElement("img");
    img.src = recipe.imageUrl || "https://via.placeholder.com/84";
    img.alt = recipe.title;

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "recipe-title";
    title.textContent = recipe.title;

    const meta = document.createElement("div");
    meta.className = "recipe-meta";
    meta.textContent = `Uses ${recipe.usedIngredientCount} of your ingredients` +
      (recipe.missedIngredientCount > 0 ? ` · needs ${recipe.missedIngredientCount} more` : "");

    const hint = document.createElement("div");
    hint.className = "recipe-tap-hint";
    hint.textContent = "Tap for full recipe";

    info.appendChild(title);
    // nothing extra needed for this one - flag it before the "uses X" line
    if (recipe.missedIngredientCount === 0) {
      const readyBadge = document.createElement("div");
      readyBadge.className = "recipe-ready-badge";
      readyBadge.textContent = "Ready to cook now";
      info.appendChild(readyBadge);
    }
    info.appendChild(meta);
    info.appendChild(hint);
    card.appendChild(img);
    card.appendChild(info);
    recipeCardsEl.appendChild(card);
  });
}

document.getElementById("back-to-list-btn").addEventListener("click", () => {
  history.back();
});

// recipe detail screen

const detailTitleEl = document.getElementById("detail-title");
const detailImageEl = document.getElementById("detail-image");
const detailMetaEl = document.getElementById("detail-meta");
const detailStatusEl = document.getElementById("detail-status");
const detailIngredientsEl = document.getElementById("detail-ingredients");
const detailInstructionsEl = document.getElementById("detail-instructions");

async function loadRecipeDetail(id) {
  detailTitleEl.textContent = "Loading recipe...";
  detailImageEl.classList.add("d-none");
  detailMetaEl.textContent = "";
  detailIngredientsEl.innerHTML = "";
  detailInstructionsEl.innerHTML = "";
  detailStatusEl.classList.add("d-none");

  try {
    const res = await apiGet(`/api/recipes/${id}`);
    if (!res.ok) {
      if (res.status === 429) {
        showAlert(
          detailStatusEl,
          "You've used up today's free recipe search limit. Please try again later.",
          "danger"
        );
      } else {
        showAlert(detailStatusEl, "Could not load this recipe. Please try another one.", "danger");
      }
      detailTitleEl.textContent = "Recipe";
      return;
    }
    const detail = await res.json();
    renderRecipeDetail(detail);
  } catch (err) {
    console.error(err);
    showAlert(detailStatusEl, "Could not reach the server. Is the back-end running?", "danger");
    detailTitleEl.textContent = "Recipe";
  }
}

function openRecipeDetail(id) {
  navigateTo("detail", { recipeId: id });
  loadRecipeDetail(id);
}

function renderRecipeDetail(detail) {
  detailTitleEl.textContent = detail.title;

  if (detail.imageUrl) {
    detailImageEl.src = detail.imageUrl;
    detailImageEl.alt = detail.title;
    detailImageEl.classList.remove("d-none");
  }

  const metaParts = [];
  if (detail.servings) metaParts.push(`Serves ${detail.servings}`);
  if (detail.readyInMinutes) metaParts.push(`${detail.readyInMinutes} min`);
  detailMetaEl.textContent = metaParts.join(" · ");

  detailIngredientsEl.innerHTML = "";
  (detail.ingredientLines || []).forEach((line) => {
    const li = document.createElement("li");
    li.className = "list-group-item";
    li.textContent = line;
    detailIngredientsEl.appendChild(li);
  });

  detailInstructionsEl.innerHTML = "";
  (detail.instructionSteps || []).forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    detailInstructionsEl.appendChild(li);
  });
}

document.getElementById("back-to-recipes-btn").addEventListener("click", () => {
  history.back();
});
