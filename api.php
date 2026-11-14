<?php
/**
 * BandiniZeroWaste — API PHP per lettura/scrittura di classificazione.json
 *
 * Endpoint unico con routing basato su ?action=, validazione input,
 * locking file-system con flock(), e risposte JSON strutturate.
 *
 * File I/O: apertura con fopen('c+'), lettura con stream_get_contents,
 * scrittura atomica tramite ftruncate + rewind + fwrite.
 *
 * @package BandiniZeroWaste
 */

declare(strict_types=1);

// ─────────────────────────────────────────────
// Configurazione
// ─────────────────────────────────────────────

/** Percorso del file dati (relativo alla radice del progetto) */
define('DATA_FILE', __DIR__ . '/data/classificazione.json');

/** Categorie ammesse (whitelist rigorosa) */
define('ALLOWED_CATEGORIES', [
    'vetro',
    'umido',
    'carta',
    'multimateriale',
    'indifferenziato',
]);

/** Max entry per categoria (RF2) */
define('MAX_ENTRIES_PER_CATEGORY', 100);

/** Soglia timeout per operazioni file (secondi) */
define('FILE_OPERATION_TIMEOUT', 10);

/** Abilita locking file-system (flock). Disabilitare su filesystem remoti (es. Altervista). */
define('ENABLE_FILE_LOCKING', false);

// ─────────────────────────────────────────────
// Helpers — Risposta JSON unificata
// ─────────────────────────────────────────────

/**
 * Invia una risposta JSON con Content-Type e codice HTTP appropriato.
 *
 * @param array<mixed> $payload  Payload da serializzare
 * @param int          $status   Codice HTTP (default 200)
 */
function json_response(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Invia una risposta di errore strutturata.
 *
 * @param string $errorCode  Codice errore (es. "unknown_action")
 * @param int    $status     Codice HTTP
 */
function json_error(string $errorCode, int $status = 400, ?string $message = null): never
{
    $payload = [
        'ok'    => false,
        'error' => $errorCode,
    ];
    if ($message !== null) {
        $payload['message'] = $message;
    }
    json_response($payload, $status);
}

// ─────────────────────────────────────────────
// Helpers — File I/O
// ─────────────────────────────────────────────

/**
 * Legge classificazione.json e restituisce l'array associativo.
 *
 * Supporta la struttura con "categories" oggetto (specifica 01).
 * Restituisce struttura vuota se il file è vuoto o inesistente.
 *
 * @return array<string, mixed>
 */
function read_classificazione(): array
{
    if (!file_exists(DATA_FILE)) {
        return ['meta' => ['last_updated' => time(), 'version' => '1.0'], 'categories' => []];
    }

    $fh = fopen(DATA_FILE, 'r');
    if ($fh === false) {
        json_error('file_open_error', 500, 'Impossibile aprire il file dati');
    }

    $content = stream_get_contents($fh);
    fclose($fh);

    if ($content === false || trim($content) === '') {
        return ['meta' => ['last_updated' => time(), 'version' => '1.0'], 'categories' => []];
    }

    $data = json_decode($content, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        json_error('invalid_json_file', 500, 'File dati corrotto: ' . json_last_error_msg());
    }

    if (!is_array($data)) {
        json_error('file_error', 500, 'Formato file dati non valido');
    }

    // Valida e normalizza struttura
    if (!isset($data['meta']) || !is_array($data['meta'])) {
        $data['meta'] = ['last_updated' => time(), 'version' => '1.0'];
    }

    // Supporta sia struttura con "categories" oggetto che flat
    if (isset($data['categories']) && is_array($data['categories'])) {
        // Struttura con categories oggetto: valida entries
        foreach ($data['categories'] as $catKey => $catData) {
            if (!isset($catData['entries']) || !is_array($catData['entries'])) {
                $data['categories'][$catKey]['entries'] = [];
            }
        }
    } else {
        // Struttura flat (vecchia): converte in struttura con categories
        $categories = [];
        foreach ($data as $key => $value) {
            if ($key === 'meta') continue;
            if (is_array($value)) {
                $categories[$key] = [
                    'display_name' => ucfirst($key),
                    'bin_id' => 'bin-' . $key,
                    'entries' => $value,
                ];
            }
        }
        $data['categories'] = $categories;
    }

    return $data;
}

/**
 * Scrive atomicamente un array in classificazione.json.
 *
 * Utilizza flock() solo se ENABLE_FILE_LOCKING è true (disabilitato su Altervista).
 * Aggiorna meta.last_updated a ogni scrittura.
 *
 * @param array<string, mixed> $data  Dati da scrivere
 */
function write_classificazione(array $data): void
{
    // Aggiorna meta.last_updated
    $data['meta']['last_updated'] = time();

    $fh = fopen(DATA_FILE, 'c+');
    if ($fh === false) {
        json_error('file_open_error', 500, 'Impossibile aprire il file dati');
    }

    // Lock esclusivo (solo se abilitato e supportato)
    if (ENABLE_FILE_LOCKING) {
        $locked = flock($fh, LOCK_EX);
        if (!$locked) {
            // Su filesystem remoti flock può fallire: logga ma continua
            error_log('flock failed (non-blocking mode)');
        }
    }

    // Tronca, riscrivi, flush
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    fflush($fh);

    // Sblocca e chiudi
    if (ENABLE_FILE_LOCKING) {
        flock($fh, LOCK_UN);
    }
    fclose($fh);
}

// ─────────────────────────────────────────────
// Helpers — CORS same-origin (RF8)
// ─────────────────────────────────────────────

/**
 * Applica header CORS solo per richieste same-origin (RF8).
 *
 * Se l'Origin della richiesta corrisponde all'origine corrente,
 * aggiunge Access-Control-Allow-Origin. Altrimenti, nessun header
 * CORS viene inviato (disabilita CORS cross-origin).
 */
function apply_cors_same_origin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return; // Nessuna Origin → richiesta same-origin o senza browser
    }

    // Costruisci l'origine corrente (scheme + host)
    $scheme = $_SERVER['SERVER_PORT'] === '443' ? 'https' : 'http';
    $selfOrigin = $scheme . '://' . $_SERVER['HTTP_HOST'];

    // Solo same-origin: confronta origine completa
    if ($origin === $selfOrigin) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
        header('Access-Control-Max-Age: 3600');
    }
    // Altrimenti: nessun header CORS → il browser bloccherà la richiesta
}

// ─────────────────────────────────────────────
// Helpers — Validazione input
// ─────────────────────────────────────────────

/**
 * Analizza il body JSON di una richiesta POST.
 *
 * @return array<string, mixed>|null  Array decodificato, o null su errore (errore già inviato)
 */
function parse_json_body(): ?array
{
    $raw = file_get_contents('php://input');
    if ($raw === false) {
        json_error('read_error', 500, 'Impossibile leggere il body della richiesta');
    }

    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        json_error('invalid_json', 400, 'Body JSON non valido: ' . json_last_error_msg());
        // Unreachable, ma il type checker lo vuole
        return null;
    }

    if (!is_array($data)) {
        json_error('invalid_json', 400, 'Il body deve essere un oggetto JSON');
        return null;
    }

    return $data;
}

/**
 * Sanitizza una stringa: rimuove tag HTML e caratteri di controllo.
 *
 * @param string $value  Stringa grezza
 * @return string        Stringa sanitizzata
 */
function sanitize_string(string $value): string
{
    // Rimuovi tag HTML
    $value = strip_tags($value);
    // Rimuovi caratteri di controllo (tranne newline/tab)
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $value);
    return $value;
}

/**
 * Verifica che una categoria sia nella whitelist.
 *
 * @param mixed $category  Valore da verificare
 * @return string|null     Categoria normalizzata (lowercase) o null se non valida
 */
function validate_category(mixed $category): ?string
{
    if (!is_string($category)) {
        return null;
    }
    $normalized = strtolower(trim($category));
    return in_array($normalized, ALLOWED_CATEGORIES, true) ? $normalized : null;
}

// ─────────────────────────────────────────────
// Handlers (stub — da implementare nelle specifiche successive)
// ─────────────────────────────────────────────

/**
 * Handler per GET ?action=get
 * (RF1 — restituisce il contenuto completo del file)
 *
 * Legge il file dati e restituisce il contenuto JSON completo
 * avvolto in { "ok": true, "data": { ... } }.
 * Se il file non esiste o è vuoto, restituisce struttura vuota valida.
 */
function handle_get(): void
{
    $data = read_classificazione();
    json_response(['ok' => true, 'data' => $data], 200);
}

// ─────────────────────────────────────────────
// Helpers — Normalizzazione e stemming
// ─────────────────────────────────────────────

/**
 * Stopwords italiane/inglesi comuni da rimuovere durante la normalizzazione.
 */
define('STOPWORDS', [
    // Italiane
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del',
    'dello', 'della', 'dei', 'degli', 'delle', 'a', 'da', 'dal', 'dallo',
    'dalla', 'dai', 'dagli', 'dalle', 'in', 'con', 'su', 'per', 'tra',
    'fra', 'e', 'o', 'ma', 'che', 'come', 'do', 'della', 'del', 'nel',
    'nello', 'nella', 'nei', 'negli', 'nelle', 'non', 'piu', 'più',
    // Inglesi
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
    'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
    'than', 'too', 'very', 'just', 'about', 'above', 'after', 'again',
    'against', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
    'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
    'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'when',
    'where', 'why', 'how', 'if', 'then', 'than', 'too', 'very',
]);

/**
 * Minimo numero di entry per la grace period (RF5).
 */
define('GRACE_PERIOD_MIN_ENTRIES', 20);

/**
 * Percentile iniziale per il calcolo dell'hitpoint (RF5).
 */
define('PERCENTILE_INITIAL_HITPOINT', 0.85);

/**
 * Soglia di overlap per il controllo quasi-duplicato (RF4).
 */
define('SIMILAR_OVERLAP_THRESHOLD', 0.80);

/**
 * Normalizza una descrizione: lowercase, trim, rimuove tag HTML e control chars,
 * rimuove stopwords e punteggiatura, applica stemming 's' finale, restituisce
 * normalized string e array di tokens.
 *
 * @param string $description  Descrizione grezza
 * @return array{normalized: string, tokens: string[]}  Array con normalized e tokens
 */
function normalize_description(string $description): array
{
    // 1. Trim e lowercase
    $value = strtolower(trim($description));
    // 2. Sanitizza (già fatto dal caller, ma per sicurezza)
    $value = sanitize_string($value);
    // 3. Rimuovi tag HTML (doppia sicurezza)
    $value = strip_tags($value);
    // 4. Rimuovi caratteri di controllo
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $value);

    // Tokenizza (split su spazi e punteggiatura)
    preg_match_all('/[a-zàèéìòù]+/i', $value, $matches);
    $tokens = $matches[0] ?? [];

    // Rimuovi stopwords
    $stopwordsLower = array_map('strtolower', STOPWORDS);
    $tokens = array_values(array_filter($tokens, function ($token) use ($stopwordsLower) {
        $t = strtolower($token);
        return !in_array($t, $stopwordsLower, true) && strlen($t) > 1;
    }));

    // Stemming 's' finale: rimuovi 's' finale se non è l'unica lettera
    $tokens = array_map(function ($token) {
        if (strlen($token) > 2 && substr($token, -1) === 's' && substr($token, -2, 1) !== 's') {
            return substr($token, 0, -1);
        }
        return $token;
    }, $tokens);

    // Ricostruisci normalized
    $normalized = implode(' ', $tokens);

    return ['normalized' => $normalized, 'tokens' => $tokens];
}

/**
 * Calcola l'overlap ratio tra due insiemi di tokens.
 * overlap = |intersezione| / min(|tokens_nuova|, |tokens_esistente|)
 *
 * @param string[] $tokensA  Tokens del primo set
 * @param string[] $tokensB  Tokens del secondo set
 * @return float             Overlap ratio [0.0, 1.0]
 */
function calculate_overlap(array $tokensA, array $tokensB): float
{
    $setA = array_unique($tokensA);
    $setB = array_unique($tokensB);

    if (empty($setA) && empty($setB)) {
        return 1.0;
    }
    if (empty($setA) || empty($setB)) {
        return 0.0;
    }

    $intersection = count(array_intersect($setA, $setB));
    $minSize = min(count($setA), count($setB));

    return $minSize > 0 ? $intersection / $minSize : 0.0;
}

/**
 * Calcola l'hitpoint iniziale usando il percentile della distribuzione
 * degli hitpoint della categoria (RF5).
 *
 * @param array<int, array<string, mixed>> $entries  Entry della categoria
 * @return int  Hitpoint iniziale
 */
function calculate_initial_hitpoint(array $entries): int
{
    $count = count($entries);

    // Se non ci sono entry, hitpoint base = 0
    if ($count === 0) {
        return 0;
    }

    // Ordina per hitpoint decrescente
    usort($entries, fn($a, $b) => $b['hitpoint'] <=> $a['hitpoint']);

    // Calcola indice percentile
    $p = PERCENTILE_INITIAL_HITPOINT;
    $idx = (int) floor($count * $p);
    $idx = min($idx, $count - 1);

    $hitpoint = $entries[$idx]['hitpoint'];

    // Grace period: se <20 entry e hitpoint calcolato = 0, usa 2
    if ($count < GRACE_PERIOD_MIN_ENTRIES && $hitpoint === 0) {
        return 2;
    }

    return $hitpoint;
}

/**
 * Genera un UUID v4.
 *
 * @return string  UUID v4 in formato hex
 */
function generate_uuid_v4(): string
{
    $bytes = random_bytes(16);
    // Set version to 4 (bits 4-7 of byte 6)
    $bytes[6] = chr(ord($bytes[6]) & 0x0F | 0x40);
    // Set variant to RFC 4122 (bits 6-7 of byte 8)
    $bytes[8] = chr(ord($bytes[8]) & 0x3F | 0x80);

    return bin2hex($bytes);
}

/**
 * Rimuove l'entry con hitpoint minimo da una categoria (usata quando la categoria è piena).
 * A parità di hitpoint, rimuove quella con update_timestamp più vecchio.
 *
 * @param array<int, array<string, mixed>> $entries  Entry della categoria
 * @return array{removed: array<string, mixed>|null, remaining: array<int, array<string, mixed>>}
 */
function remove_lowest_hitpoint_entry(array $entries): array
{
    if (empty($entries)) {
        return ['removed' => null, 'remaining' => []];
    }

    $lowestIdx = 0;
    $lowestHp = $entries[0]['hitpoint'];
    $lowestTs = $entries[0]['update_timestamp'];

    foreach ($entries as $idx => $entry) {
        $hp = $entry['hitpoint'];
        $ts = $entry['update_timestamp'];

        if ($hp < $lowestHp || ($hp === $lowestHp && $ts < $lowestTs)) {
            $lowestIdx = $idx;
            $lowestHp = $hp;
            $lowestTs = $ts;
        }
    }

    $removed = $entries[$lowestIdx];
    unset($entries[$lowestIdx]);
    // Riordina gli indici
    $entries = array_values($entries);

    return ['removed' => $removed, 'remaining' => $entries];
}

/**
 * Handler per POST ?action=add_entry
 * (RF2 — aggiunge una nuova entry con validazione e locking)
 */
function handle_add_entry(array $body): void
{
    // ── 1. Validazione categoria ──
    $category = validate_category($body['category'] ?? null);
    if ($category === null) {
        json_error('invalid_category', 400, 'Categoria non valida. Ammesse: ' . implode(', ', ALLOWED_CATEGORIES));
    }

    // ── 2. Validazione description ──
    if (!array_key_exists('description', $body) || $body['description'] === null || $body['description'] === '') {
        json_error('missing_description', 400, 'Il campo description è obbligatorio');
    }

    if (!is_string($body['description'])) {
        json_error('missing_description', 400, 'description deve essere una stringa');
    }

    $description = trim($body['description']);

    if (strlen($description) < 3) {
        json_error('description_too_short', 400, 'La descrizione deve avere almeno 3 caratteri');
    }

    if (strlen($description) > 120) {
        json_error('description_too_long', 400, 'La descrizione non può superare i 120 caratteri');
    }

    // ── 3. Normalizzazione ──
    $normalized = normalize_description($description);
    $normalizedStr = $normalized['normalized'];
    $tokens = $normalized['tokens'];

    // ── 4. Lettura dati esistenti ──
    $data = read_classificazione();

    // Inizializza categories se non esiste
    if (!isset($data['categories']) || !is_array($data['categories'])) {
        $data['categories'] = [];
    }

    // Inizializza categoria se non esiste
    if (!isset($data['categories'][$category])) {
        $data['categories'][$category] = [
            'display_name' => ucfirst($category),
            'bin_id' => 'bin-' . $category,
            'entries' => [],
        ];
    }

    $entries = $data['categories'][$category]['entries'];

    // ── 5. Controllo anti-duplicato (RF4) ──
    foreach ($entries as $existing) {
        // 5a. Duplicato esatto su normalized
        if (isset($existing['normalized']) && $existing['normalized'] === $normalizedStr) {
            json_error('duplicate_exact', 409, 'Descrizione già presente', [
                'similar_to' => $existing['description'],
            ]);
        }

        // 5b. Quasi-duplicato su tokens overlap
        if (isset($existing['tokens']) && is_array($existing['tokens'])) {
            $overlap = calculate_overlap($tokens, $existing['tokens']);
            if ($overlap >= SIMILAR_OVERLAP_THRESHOLD) {
                json_error('duplicate_similar', 409, 'Descrizione simile già presente', [
                    'similar_to' => $existing['description'],
                    'overlap'    => round($overlap, 2),
                ]);
            }
        }
    }

    // ── 6. Calcolo hitpoint iniziale (RF5) ──
    $initialHitpoint = calculate_initial_hitpoint($entries);

    // ── 7. Creazione entry ──
    $now = time();
    $newEntry = [
        'id'             => generate_uuid_v4(),
        'description'    => $description,
        'normalized'     => $normalizedStr,
        'tokens'         => $tokens,
        'hitpoint'       => $initialHitpoint,
        'source'         => 'human',
        'created_at'     => $now,
        'update_timestamp' => $now,
    ];

    // ── 8. Se categoria piena, rimuovi entry con hitpoint minimo ──
    if (count($entries) >= MAX_ENTRIES_PER_CATEGORY) {
        $result = remove_lowest_hitpoint_entry($entries);
        $entries = $result['remaining'];
    }

    // ── 9. Aggiungi nuova entry ──
    $entries[] = $newEntry;
    $data['categories'][$category]['entries'] = $entries;

    // ── 10. Scrivi atomicamente ──
    write_classificazione($data);

    // ── 11. Risposta di successo ──
    json_response([
        'ok'    => true,
        'entry' => $newEntry,
    ], 200);
}

/**
 * Genera un entry_id slug (categoria-indice) coerente con generateEntryId() in JS.
 *
 * @param string $category  Categoria (es. 'vetro')
 * @param int    $index     Indice nell'array entries
 * @return string           Entry ID slug (es. 'vetro-0')
 */
function generate_entry_id_slug(string $category, int $index): string
{
    $slug = strtolower($category);
    $slug = preg_replace('/\s+/', '-', $slug);
    $slug = preg_replace('/[^a-z0-9-]/', '', $slug);
    return $slug . '-' . $index;
}

/**
 * Handler per POST ?action=hit
 * (RF3 — incrementa hitpoint di una entry)
 */
function handle_hit(array $body): void
{
    // ── 1. Validazione entry_id ──
    if (!array_key_exists('entry_id', $body) || $body['entry_id'] === null || $body['entry_id'] === '') {
        json_error('missing_entry_id', 400, 'Il campo entry_id è obbligatorio');
    }

    $entryId = (string) $body['entry_id'];

    // ── 2. Lettura dati esistenti ──
    $data = read_classificazione();

    // Inizializza categories se non esiste
    if (!isset($data['categories']) || !is_array($data['categories'])) {
        json_error('entry_not_found', 404, 'Entry non trovata con id: ' . $entryId);
    }

    // ── 3. Cerca entry_id in tutte le categorie ──
    // Supporta sia UUID (entry['id']) che slug-based (categoria-indice)
    $found = false;
    $foundCategory = null;
    $foundIdx = null;

    foreach ($data['categories'] as $cat => $catData) {
        $entries = $catData['entries'] ?? [];
        foreach ($entries as $idx => $entry) {
            // Cerca per UUID
            if (isset($entry['id']) && $entry['id'] === $entryId) {
                $found = true;
                $foundCategory = $cat;
                $foundIdx = $idx;
                break 2;
            }
            // Cerca per entry_id slug (categoria-indice)
            $slugId = generate_entry_id_slug($cat, $idx);
            if ($slugId === $entryId) {
                $found = true;
                $foundCategory = $cat;
                $foundIdx = $idx;
                break 2;
            }
        }
    }

    // ── 4. Se non trovata → 404 ──
    if (!$found) {
        json_error('entry_not_found', 404, 'Entry non trovata con id: ' . $entryId);
    }

    // ── 5. Incrementa hitpoint e aggiorna timestamp ──
    $data['categories'][$foundCategory]['entries'][$foundIdx]['hitpoint'] += 1;
    $data['categories'][$foundCategory]['entries'][$foundIdx]['update_timestamp'] = time();
    $newHitpoint = $data['categories'][$foundCategory]['entries'][$foundIdx]['hitpoint'];

    // ── 6. Scrivi atomicamente ──
    write_classificazione($data);

    // ── 7. Risposta di successo ──
    json_response([
        'ok'      => true,
        'hitpoint' => $newHitpoint,
    ], 200);
}

// ─────────────────────────────────────────────
// Router principale
// ─────────────────────────────────────────────

// Applica CORS same-origin (RF8)
apply_cors_same_origin();

// Global error handler: cattura errori non gestiti e restituisce JSON 500
set_error_handler(function(int $errno, string $errstr, string $errfile, int $errline) {
    error_log("[API Error] $errstr in $errfile:$errline");
    json_error('internal_error', 500, 'Errore interno del server');
    return true; // evita l'esecuzione del default error handler
});

set_exception_handler(function(\Throwable $e) {
    error_log("[API Exception] " . $e->getMessage() . " in " . $e->getFile() . ":" . $e->getLine());
    json_error('internal_error', 500, 'Errore interno del server');
});

try {
    // Determina l'azione richiesta
    $action = $_GET['action'] ?? '';

    // Routing dispatch
    $handlers = [
        'get'       => 'handle_get',
        'add_entry' => 'handle_add_entry',
        'hit'       => 'handle_hit',
    ];

    // Azioni POST — richiede body JSON
    $post_actions = ['add_entry', 'hit'];

    // ── Validazione azione ──
    if ($action === '') {
        json_error('missing_action', 400, 'Parametro ?action= mancante');
    }

    if (!array_key_exists($action, $handlers)) {
        json_error('unknown_action', 400);
    }

    // ── Dispatch per metodo HTTP ──
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'POST' && in_array($action, $post_actions, true)) {
        // Parsing body JSON
        $body = parse_json_body();
        if ($body === null) {
            // Errore già inviato da parse_json_body()
            exit;
        }

        // Chiamata handler
        $handler = $handlers[$action];
        $handler($body);
    } elseif ($method === 'GET' && $action === 'get') {
        handle_get();
    } else {
        json_error('method_not_allowed', 405, "Metodo $method non supportato per action=$action");
    }
} catch (\Throwable $e) {
    // Catch-all finale: mai lasciare PHP crashare senza risposta
    error_log("[API Fatal] " . $e->getMessage() . " in " . $e->getFile() . ":" . $e->getLine());
    json_error('internal_error', 500, 'Errore interno del server');
}
