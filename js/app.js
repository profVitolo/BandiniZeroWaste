import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

// 1. Disabilita i modelli locali e abilita quelli remoti via Hugging Face CDN
env.allowLocalModels = false;
env.allowRemoteModels = true;

const video = document.getElementById('webcam');
const btnClassify = document.getElementById('btn-classify');
const statusDiv = document.getElementById('status');
const resultDiv = document.getElementById('result');

// Variabile globale per il modello
let classifier = null;

// Variabile globale per gestire il timer di chiusura automatica dei bidoni
let closeTimer = null;

// 2. Configurazione dei prompt di analisi e delle relative categorie finali
const LABEL_MAPPING = [
  {
    category: "carta e cartone",
    binId: "bin-carta",
    prompt: "a photo of paper, cardboard, newspaper, carton box, or paper bag, or book"
  },
  {
    category: "umido",
    binId: "bin-umido",
    prompt: "a photo of organic food waste, fruit peel, vegetable scraps, or food remains"
  },
  {
    category: "multimateriale",
    binId: "bin-multimateriale",
    prompt: "a photo of a plastic bottle, plastic packaging, drink can, aluminum tin, or beverage carton"
  },
  {
    category: "vetro",
    binId: "bin-vetro",
    prompt: "a photo of a glass bottle or glass jar"
  },
  {
    category: "indifferenziato/nc",
    binId: "bin-indifferenziato",
    prompt: "a photo of an empty background, human hand, room wall, or unrecognized object"
  }
];

// Soglia minima di confidenza (es. 35%)
const CONFIDENCE_THRESHOLD = 0.35;

// 3. Avvio Webcam
async function setupWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { width: 400, height: 300 } 
    });
    video.srcObject = stream;
  } catch (err) {
    statusDiv.innerText = "Errore nell'accesso alla webcam: " + err.message;
  }
}

// 4. Inizializzazione Modello CLIP da Hugging Face
async function initModel() {
  try {
    statusDiv.innerText = "Caricamento modello da Hugging Face (potrebbe impiegare qualche secondo)...";
    
    classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch16');

    statusDiv.innerText = "Modello pronto! Inquadra il rifiuto.";
    btnClassify.disabled = false;
    btnClassify.innerText = "Classifica Rifiuto";
  } catch (err) {
    statusDiv.innerText = "Errore caricamento modello: " + err.message;
    console.error(err);
  }
}

// 5. Funzione di Classificazione con cattura fotogramma su Canvas
async function classifyFrame() {
  if (!classifier) return;
    
  try {
    // 1. Crea il canvas e disegna il fotogramma corrente della webcam
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 400;
    canvas.height = video.videoHeight || 300;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 2. Converte il canvas in un oggetto RawImage compatibile con Transformers.js
    const image = RawImage.fromCanvas(canvas);

    // 3. Prepara i prompt e passa l'oggetto immagine al modello CLIP
    const candidatePrompts = LABEL_MAPPING.map(item => item.prompt);
    const output = await classifier(image, candidatePrompts);

    console.log("Output CLIP:", output);

    const topMatch = output[0];
    let finalCategory = "indifferenziato/nc";
    let targetBinId = "bin-indifferenziato";

    if (topMatch.score >= CONFIDENCE_THRESHOLD && !topMatch.label.includes("empty background")) {
      const matchedItem = LABEL_MAPPING.find(item => item.prompt === topMatch.label);
      if (matchedItem) {
        finalCategory = matchedItem.category;
        targetBinId = matchedItem.binId;
      }
    }

    // Aggiorna interfaccia e apre il bidone corrispondente
    resultDiv.innerText = finalCategory;
    statusDiv.innerText = `Riconosciuto: ${finalCategory.toUpperCase()} (Confidenza: ${(topMatch.score * 100).toFixed(1)}%)`;
    console.log(targetBinId);
    
    openBin(targetBinId);

  } catch (err) {
    btnClassify.disabled = false;
    btnClassify.textContent = "Classifica Rifiuto";
    resultDiv.innerText = "In attesa di scansione...";
    statusDiv.innerText = "Errore durante la classificazione: " + err.message;
    console.error(err);
  }
}

// 6. Gestione apertura e chiusura temporizzata del bidone con countdown visivo
function openBin(targetBinId) {
  if (closeTimer) {
    clearInterval(closeTimer);
  }

  // Chiudi prima tutti i coperchi
  document.querySelectorAll('.bin-lid').forEach(lid => {
    lid.classList.remove('open');
    lid.classList.add('close');
  });

  // Apri il coperchio del bidone identificato
  if (targetBinId) {
    const binElement = document.getElementById(targetBinId);
    if (binElement) {
      const lid = binElement.querySelector('.bin-lid');
      if (lid) {
        lid.classList.remove('close');
        lid.classList.add('open');
      }
    }
  }

  // Gestione del countdown dinamico (5 secondi)
  let secondsLeft = 5;
  btnClassify.textContent = `Attendi ${secondsLeft} secondi...`;

  closeTimer = setInterval(() => {
    secondsLeft--;

    if (secondsLeft > 0) {
      btnClassify.textContent = `Attendi ${secondsLeft} second${secondsLeft === 1 ? 'o' : 'i'}...`;
    } else {
      clearInterval(closeTimer);

      document.querySelectorAll('.bin-lid').forEach(lid => {
        lid.classList.remove('open');
        lid.classList.add('close');
      });

      btnClassify.disabled = false;
      btnClassify.textContent = "Classifica Rifiuto";
      resultDiv.innerText = "In attesa di scansione...";
      statusDiv.innerText = "Pronto per una nuova scansione!";
    }
  }, 1000);
}

// Event Listeners e Avvio
btnClassify.addEventListener('click', async function() {
    btnClassify.disabled = true;
    btnClassify.textContent = "Analisi in corso...";
    resultDiv.innerText = "Elaborazione...";
    statusDiv.innerText = "Cattura fotogramma e analisi in corso...";
    
    await new Promise(resolve => setTimeout(resolve, 20));
    classifyFrame();
});

// Avvia webcam e modello
await setupWebcam();
await initModel();