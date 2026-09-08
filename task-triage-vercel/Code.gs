/**
 * Central de Triagem — Backend Google Apps Script
 * ------------------------------------------------
 * Backend para o site estático hospedado no Vercel.
 *
 * Armazena apenas as tarefas interpretadas/criadas na aba "Tarefas".
 * O texto bruto enviado para a IA não é persistido na planilha.
 *
 * Script Properties suportadas:
 *  - ANTHROPIC_API_KEY  (obrigatória para análise por IA)
 *  - APP_ACCESS_KEY     (recomendada; protege o backend publicado como "Anyone")
 *  - AI_MODEL           (opcional; padrão: claude-sonnet-4-6)
 *  - SPREADSHEET_ID     (opcional se o script estiver vinculado à própria planilha)
 */

const APP_VERSION = '2.1.0';
const TASKS_SHEET = 'Tarefas';
const DEFAULT_AI_MODEL = 'claude-sonnet-4-6';
const MAX_INPUT_CHARS = 12000;
const MAX_TASKS_PER_ANALYSIS = 30;

const TASK_HEADERS = [
  'id',
  'title',
  'description',
  'priority',
  'status',
  'category',
  'dueDate',
  'createdAt',
  'updatedAt',
  'source'
];

function doGet() {
  const props = PropertiesService.getScriptProperties();
  return json_({
    ok: true,
    service: 'task-triage-backend',
    version: APP_VERSION,
    requiresAccessKey: Boolean(props.getProperty('APP_ACCESS_KEY'))
  });
}

function doPost(e) {
  try {
    const payload = parseRequest_(e);
    requireAccess_(payload);
    ensureSheets_();

    const action = String(payload.action || '').trim().toLowerCase();

    switch (action) {
      case 'health':
        return json_({ ok: true, version: APP_VERSION });
      case 'list':
        return json_({ ok: true, tasks: listTasks_() });
      case 'create':
        return json_({ ok: true, task: createTask_(payload.task || {}) });
      case 'update':
        return json_({ ok: true, task: updateTask_(payload.id, payload.task || {}) });
      case 'toggle':
        return json_({ ok: true, task: toggleTask_(payload.id) });
      case 'delete':
        deleteTask_(payload.id);
        return json_({ ok: true, id: String(payload.id || '') });
      case 'analyze':
        return json_(analyzeAndStore_(payload));
      default:
        throw appError_('INVALID_ACTION', 'Ação inválida ou não informada.');
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({
      ok: false,
      code: err && err.code ? err.code : 'SERVER_ERROR',
      error: safeErrorMessage_(err)
    });
  }
}

/**
 * Execute UMA VEZ manualmente no editor do Apps Script.
 * Cria/ajusta as abas e mostra um diagnóstico das propriedades.
 */
function setupProject() {
  ensureSheets_();

  const props = PropertiesService.getScriptProperties();
  const result = {
    ok: true,
    spreadsheet: getSpreadsheet_().getName(),
    tasksSheet: TASKS_SHEET,
    hasAnthropicKey: Boolean(props.getProperty('ANTHROPIC_API_KEY')),
    hasAccessKey: Boolean(props.getProperty('APP_ACCESS_KEY')),
    aiModel: props.getProperty('AI_MODEL') || DEFAULT_AI_MODEL,
    timezone: Session.getScriptTimeZone(),
    version: APP_VERSION
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

// -----------------------------------------------------------------------------
// Requisição, autenticação e resposta
// -----------------------------------------------------------------------------

function parseRequest_(e) {
  const body = e && e.postData && typeof e.postData.contents === 'string'
    ? e.postData.contents
    : '';

  if (!body) {
    throw appError_('EMPTY_REQUEST', 'Corpo da requisição vazio.');
  }

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Objeto JSON esperado.');
    }
    return parsed;
  } catch (err) {
    throw appError_('INVALID_JSON', 'JSON da requisição inválido.');
  }
}

function requireAccess_(payload) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_ACCESS_KEY');
  if (!expected) return;

  const supplied = String(payload && payload.accessKey ? payload.accessKey : '');
  if (!supplied || supplied !== expected) {
    throw appError_('ACCESS_REQUIRED', 'Chave de acesso inválida ou não informada.');
  }
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function appError_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safeErrorMessage_(err) {
  const msg = err && err.message ? String(err.message) : 'Erro interno no servidor.';
  return msg.slice(0, 500);
}

// -----------------------------------------------------------------------------
// Planilha
// -----------------------------------------------------------------------------

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw appError_(
      'SPREADSHEET_NOT_CONFIGURED',
      'Planilha não encontrada. Vincule o Apps Script a uma planilha ou defina SPREADSHEET_ID nas propriedades do script.'
    );
  }
  return active;
}

function ensureSheets_() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, TASKS_SHEET, TASK_HEADERS);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  const matches = headers.every((h, i) => current[i] === h);

  if (!matches) {
    const isEmpty = sheet.getLastRow() <= 1 && current.every(v => !v);
    if (!isEmpty && sheet.getLastRow() > 1) {
      throw appError_(
        'INVALID_SHEET_SCHEMA',
        'A aba "' + name + '" já possui dados com cabeçalhos diferentes. Renomeie essa aba ou ajuste os cabeçalhos antes de continuar.'
      );
    }
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');

  return sheet;
}

function getTaskSheet_() {
  return getSpreadsheet_().getSheetByName(TASKS_SHEET);
}


function listTasks_() {
  const sheet = getTaskSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, TASK_HEADERS.length).getDisplayValues();
  return values
    .filter(row => row[0])
    .map(rowToTask_)
    .sort((a, b) => dateMs_(b.createdAt) - dateMs_(a.createdAt));
}

function rowToTask_(row) {
  return {
    id: row[0] || '',
    title: row[1] || '',
    description: row[2] || '',
    priority: normalizePriority_(row[3]),
    status: normalizeStatus_(row[4]),
    category: row[5] || 'geral',
    dueDate: normalizeDueDate_(row[6]),
    createdAt: row[7] || '',
    updatedAt: row[8] || '',
    source: row[9] || 'manual'
  };
}

function taskToRow_(task) {
  return [
    task.id,
    task.title,
    task.description,
    task.priority,
    task.status,
    task.category,
    task.dueDate,
    task.createdAt,
    task.updatedAt,
    task.source
  ];
}

function findTaskRow_(id) {
  const taskId = String(id || '').trim();
  if (!taskId) throw appError_('INVALID_ID', 'ID da tarefa não informado.');

  const sheet = getTaskSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === taskId) return i + 2;
  }
  return -1;
}

function createTask_(input) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const now = nowIso_();
    const task = normalizeTask_(input, {
      id: makeId_('t'),
      createdAt: now,
      updatedAt: now,
      source: 'manual'
    });

    getTaskSheet_().appendRow(taskToRow_(task));
    return task;
  } finally {
    lock.releaseLock();
  }
}

function updateTask_(id, patch) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const rowIndex = findTaskRow_(id);
    if (rowIndex < 0) throw appError_('NOT_FOUND', 'Tarefa não encontrada.');

    const sheet = getTaskSheet_();
    const old = rowToTask_(sheet.getRange(rowIndex, 1, 1, TASK_HEADERS.length).getDisplayValues()[0]);
    const task = normalizeTask_(Object.assign({}, old, patch), {
      id: old.id,
      createdAt: old.createdAt || nowIso_(),
      updatedAt: nowIso_(),
      source: old.source || 'manual'
    });

    sheet.getRange(rowIndex, 1, 1, TASK_HEADERS.length).setValues([taskToRow_(task)]);
    return task;
  } finally {
    lock.releaseLock();
  }
}

function toggleTask_(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const rowIndex = findTaskRow_(id);
    if (rowIndex < 0) throw appError_('NOT_FOUND', 'Tarefa não encontrada.');

    const sheet = getTaskSheet_();
    const old = rowToTask_(sheet.getRange(rowIndex, 1, 1, TASK_HEADERS.length).getDisplayValues()[0]);
    const task = Object.assign({}, old, {
      status: old.status === 'concluida' ? 'pendente' : 'concluida',
      updatedAt: nowIso_()
    });

    sheet.getRange(rowIndex, 1, 1, TASK_HEADERS.length).setValues([taskToRow_(task)]);
    return task;
  } finally {
    lock.releaseLock();
  }
}

function deleteTask_(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const rowIndex = findTaskRow_(id);
    if (rowIndex < 0) throw appError_('NOT_FOUND', 'Tarefa não encontrada.');
    getTaskSheet_().deleteRow(rowIndex);
  } finally {
    lock.releaseLock();
  }
}

// -----------------------------------------------------------------------------
// IA — interpreta o texto e persiste somente as tarefas resultantes
// -----------------------------------------------------------------------------

function analyzeAndStore_(payload) {
  const text = String(payload.text || '').trim();
  if (!text) throw appError_('EMPTY_TEXT', 'Digite um texto para analisar.');
  if (text.length > MAX_INPUT_CHARS) {
    throw appError_('TEXT_TOO_LONG', 'O texto passou do limite de ' + MAX_INPUT_CHARS + ' caracteres.');
  }

  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw appError_(
      'AI_NOT_CONFIGURED',
      'A chave ANTHROPIC_API_KEY não foi configurada nas propriedades do Apps Script.'
    );
  }

  const model = props.getProperty('AI_MODEL') || DEFAULT_AI_MODEL;
  const createdAt = nowIso_();
  const prompt = buildTriagePrompt_(text);
  const rawModelText = callAnthropic_(apiKey, model, prompt);
  const aiTasks = parseAiTasks_(rawModelText);
  const stored = storeAiTasks_(aiTasks, createdAt);

  return {
    ok: true,
    tasks: stored,
    model: model
  };
}

function storeAiTasks_(items, createdAt) {
  if (!items.length) return [];

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const sheet = getTaskSheet_();
    const now = nowIso_();
    const tasks = items.slice(0, MAX_TASKS_PER_ANALYSIS).map(item => normalizeTask_(item, {
      id: makeId_('t'),
      createdAt: createdAt,
      updatedAt: now,
      source: 'ia'
    }));

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, tasks.length, TASK_HEADERS.length).setValues(tasks.map(taskToRow_));
    return tasks;
  } finally {
    lock.releaseLock();
  }
}

function callAnthropic_(apiKey, model, prompt) {
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: model,
      max_tokens: 2500,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    }),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw appError_('AI_INVALID_RESPONSE', 'A API da IA retornou uma resposta que não é JSON.');
  }

  if (status < 200 || status >= 300) {
    const apiMessage = data && data.error && data.error.message
      ? String(data.error.message)
      : 'status ' + status;
    throw appError_('AI_API_ERROR', 'Falha na API da IA: ' + apiMessage.slice(0, 300));
  }

  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw appError_('AI_EMPTY_RESPONSE', 'A IA não retornou texto para analisar.');
  }

  return text;
}

function buildTriagePrompt_(rawText) {
  const tz = Session.getScriptTimeZone() || 'America/Fortaleza';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  return [
    'Você é um assistente especialista em organização e triagem de tarefas.',
    'Data de hoje: ' + today + '.',
    'Fuso horário do sistema: ' + tz + '.',
    '',
    'Analise o relato e transforme somente ações reais em tarefas distintas.',
    '',
    'Regras:',
    '1. Una menções duplicadas da mesma tarefa em uma única tarefa.',
    '2. Ignore contexto, desabafo ou explicação que não represente uma ação concreta.',
    '3. Crie títulos curtos, objetivos e reescritos com suas próprias palavras.',
    '4. Prioridade alta: prazo muito próximo, reunião/compromisso iminente, bloqueio importante, forte consequência ou urgência real.',
    '5. Prioridade media: importante, mas pode ser planejada nos próximos dias sem consequência imediata.',
    '6. Prioridade baixa: flexível, sem prazo claro ou com baixo impacto.',
    '7. Use status "concluida" somente quando o relato deixar claro que a ação já foi terminada/resolvida.',
    '8. Categoria: identifique o contexto quando houver pistas. Exemplos úteis: segcomp, energycomp, techcomp, healthcomp, estudo, pessoal, financeiro, casa, geral.',
    '9. Prazo: retorne dueDate em YYYY-MM-DD. Resolva expressões relativas como hoje, amanhã e próxima sexta usando a data informada. Se não houver prazo inferível com segurança, use string vazia.',
    '10. A descrição deve guardar detalhes úteis que não couberem no título, sem inventar informações.',
    '',
    'Responda SOMENTE com um array JSON válido dentro de <json></json>. Não use markdown e não escreva análise fora desse bloco.',
    'Formato de cada objeto:',
    '{"title":"...","description":"...","priority":"alta|media|baixa","status":"pendente|concluida","category":"...","dueDate":"YYYY-MM-DD ou vazio"}',
    '',
    'Relato:',
    '"""',
    rawText,
    '"""',
    '',
    'Se não houver nenhuma tarefa concreta, retorne <json>[]</json>.'
  ].join('\n');
}

function parseAiTasks_(raw) {
  let candidate = String(raw || '').trim();

  const tagged = candidate.match(/<json>([\s\S]*?)<\/json>/i);
  if (tagged) candidate = tagged[1].trim();

  candidate = candidate
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (!candidate.startsWith('[')) {
    const first = candidate.indexOf('[');
    const last = candidate.lastIndexOf(']');
    if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw appError_('AI_INVALID_FORMAT', 'A IA retornou um formato de tarefas inválido.');
  }

  if (!Array.isArray(parsed)) {
    throw appError_('AI_INVALID_FORMAT', 'A IA não retornou uma lista de tarefas.');
  }

  return parsed.slice(0, MAX_TASKS_PER_ANALYSIS).map(item => ({
    title: stringLimit_(item && item.title, 120),
    description: stringLimit_(item && item.description, 2000),
    priority: normalizePriority_(item && item.priority),
    status: normalizeStatus_(item && item.status),
    category: normalizeCategory_(item && item.category),
    dueDate: normalizeDueDate_(item && item.dueDate)
  })).filter(item => item.title);
}

// -----------------------------------------------------------------------------
// Normalização
// -----------------------------------------------------------------------------

function normalizeTask_(input, fixed) {
  const title = stringLimit_(input && input.title, 120).trim();
  if (!title) throw appError_('INVALID_TASK', 'O título da tarefa é obrigatório.');

  return {
    id: fixed.id,
    title: title,
    description: stringLimit_(input && input.description, 2000).trim(),
    priority: normalizePriority_(input && input.priority),
    status: normalizeStatus_(input && input.status),
    category: normalizeCategory_(input && input.category),
    dueDate: normalizeDueDate_(input && input.dueDate),
    createdAt: fixed.createdAt,
    updatedAt: fixed.updatedAt,
    source: fixed.source
  };
}

function normalizePriority_(value) {
  const v = String(value || '').toLowerCase().trim();
  return ['alta', 'media', 'baixa'].indexOf(v) >= 0 ? v : 'baixa';
}

function normalizeStatus_(value) {
  return String(value || '').toLowerCase().trim() === 'concluida' ? 'concluida' : 'pendente';
}

function normalizeCategory_(value) {
  const v = stringLimit_(value || 'geral', 60).trim().toLowerCase();
  return v || 'geral';
}

function normalizeDueDate_(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function stringLimit_(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}

function nowIso_() {
  return new Date().toISOString();
}

function dateMs_(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function makeId_(prefix) {
  return prefix + '-' + Utilities.getUuid();
}
