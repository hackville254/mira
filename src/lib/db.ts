import Database from "@tauri-apps/plugin-sql";

let _db: Database | null = null;

async function getDb(): Promise<Database> {
  if (_db) return _db;
  const db = await Database.load("sqlite:origin-chat.db");
  await _initSchema(db);
  // Only cache the singleton after schema init succeeds — otherwise a failed
  // init would leave an unusable instance cached and every later call would
  // skip re-initialization.
  _db = db;
  return _db;
}

async function _initSchema(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      active_model TEXT NOT NULL,
      active_provider TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      attachments_json TEXT,
      editor_context_json TEXT,
      tool_calls_json TEXT,
      status TEXT NOT NULL DEFAULT 'complete',
      model TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  // Migration: add column for existing databases that pre-date tool call persistence
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN tool_calls_json TEXT`);
  } catch (_e) {
    // Column already exists — ignore
  }
  // Migration: lien vers la session SDK Cline persistée.
  //
  // POURQUOI
  // --------
  // Une session UI (ligne SQLite locale) et une session Cline Core (SQLite du
  // sidecar) sont deux identités distinctes. Sans ce lien, chaque message
  // ouvrait une NOUVELLE session SDK : l'agent repartait de zéro et perdait
  // toute continuité (contexte, todos, équipes). En mémorisant l'id SDK sur la
  // session UI, on peut REJOUER les tours suivants via `send` (voir
  // `AiPanel.handleSend`) au lieu de recréer une session.
  try {
    await db.execute(`ALTER TABLE sessions ADD COLUMN cline_session_id TEXT`);
  } catch (_e) {
    // Column already exists — ignore
  }
  // Migration: mode applicatif (IDE/AI) au moment de la création de la session.
  //
  // POURQUOI
  // --------
  // Le mode IDE et le mode AI n'ont pas la même capacité d'agent : la délégation
  // multi-agents (sous-agents / équipes) n'a de sens qu'en mode AI. Or Trae
  // garantit qu'une conversation ne perd RIEN quand on bascule d'un mode à
  // l'autre. On mémorise donc le mode de CRÉATION de la conversation (source de
  // vérité) : à la reprise, ce mode fait foi quel que soit le layout courant, et
  // les sous-agents restent donc disponibles si la conversation a été ouverte en
  // mode AI. `NULL` = conversation héritée d'avant cette migration ; on retombe
  // alors sur le mode courant (dégradation gracieuse).
  try {
    await db.execute(`ALTER TABLE sessions ADD COLUMN app_mode TEXT`);
  } catch (_e) {
    // Column already exists — ignore
  }
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path, updated_at DESC)`
  );
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC)`
  );
  // Mark messages left in-flight from a previous crash as interrupted
  await db.execute(`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`);
}

export interface DbSession {
  id: string;
  workspace_path: string;
  title: string;
  active_model: string;
  active_provider: string;
  created_at: number;
  updated_at: number;
  /** Id de la session SDK Cline associée, `null` tant qu'aucun tour n'a tourné. */
  cline_session_id?: string | null;
  /** Mode applicatif de création (`'ide' | 'ai'`), `null` pour les sessions héritées. */
  app_mode?: string | null;
}

export interface DbMessage {
  id: string;
  session_id: string;
  message_type: string;
  content: string;
  attachments_json: string | null;
  editor_context_json: string | null;
  tool_calls_json: string | null;
  status: string;
  model: string | null;
  created_at: number;
}

export async function initDb(): Promise<void> {
  await getDb();
}

export async function createSession(
  workspacePath: string,
  title: string,
  model: string,
  provider: string,
  id?: string,
  appMode?: 'ide' | 'ai',
): Promise<string> {
  const db = await getDb();
  const sessionId = id ?? crypto.randomUUID();
  const now = Date.now();
  await db.execute(
    `INSERT INTO sessions (id, workspace_path, title, active_model, active_provider, created_at, updated_at, app_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, workspacePath, title, model, provider, now, now, appMode ?? null],
  );
  return sessionId;
}

export async function touchSession(id: string, model: string, provider: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE sessions SET active_model = ?, active_provider = ?, updated_at = ? WHERE id = ?`,
    [model, provider, Date.now(), id],
  );
}

export async function listSessions(workspacePath: string): Promise<DbSession[]> {
  const db = await getDb();
  return db.select<DbSession[]>(
    `SELECT * FROM sessions WHERE workspace_path = ? ORDER BY updated_at DESC`,
    [workspacePath],
  );
}

export async function insertMessage(params: {
  sessionId: string;
  messageType: string;
  content: string;
  status?: string;
  attachmentsJson?: string | null;
  editorContextJson?: string | null;
  model?: string | null;
  /**
   * Horodatage d'insertion (ms epoch). Optionnel : par défaut `Date.now()`.
   * Sert à figer un ORDRE DÉTERMINISTE quand plusieurs messages d'un même tour
   * sont insérés en parallèle (bulle utilisateur + placeholder assistant) : sans
   * cela, deux `Date.now()` égaux rendaient l'ordre de relecture non
   * déterministe (bulles mélangées à la réhydratation).
   */
  createdAt?: number;
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO messages (id, session_id, message_type, content, attachments_json, editor_context_json, status, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.sessionId,
      params.messageType,
      params.content,
      params.attachmentsJson ?? null,
      params.editorContextJson ?? null,
      params.status ?? 'complete',
      params.model ?? null,
      params.createdAt ?? Date.now(),
    ],
  );
  return id;
}

export async function updateMessageContent(
  id: string,
  content: string,
  status: string,
  toolCallsJson?: string | null,
): Promise<void> {
  const db = await getDb();
  if (toolCallsJson !== undefined) {
    await db.execute(
      `UPDATE messages SET content = ?, status = ?, tool_calls_json = ? WHERE id = ?`,
      [content, status, toolCallsJson, id],
    );
  } else {
    await db.execute(
      `UPDATE messages SET content = ?, status = ? WHERE id = ?`,
      [content, status, id],
    );
  }
}

export async function loadMessages(sessionId: string): Promise<DbMessage[]> {
  const db = await getDb();
  return db.select<DbMessage[]>(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    [sessionId],
  );
}

/**
 * Supprime des messages par id, en se limitant à une session donnée.
 * Le `AND session_id = ?` est une garde d'appartenance : même si un id
 * provenait d'une autre session (bug d'appelant), on ne peut pas l'effacer
 * depuis le contexte de cette session — pas de suppression croisée.
 */
export async function deleteMessagesByIds(sessionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  await db.execute(
    `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`,
    [sessionId, ...ids],
  );
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM messages WHERE session_id = ?`, [id]);
  await db.execute(`DELETE FROM sessions WHERE id = ?`, [id]);
}

/**
 * Lit l'id de la session SDK Cline rattachée à une session UI.
 *
 * Renvoie `null` si la session n'existe pas ou n'a encore jamais tourné (le
 * premier `send` la crée et l'enregistre). C'est cette valeur qui décide, dans
 * `AiPanel`, entre RÉUTILISER la session SDK (continuité) et en démarrer une.
 */
export async function getClineSessionId(sessionId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ cline_session_id: string | null }[]>(
    `SELECT cline_session_id FROM sessions WHERE id = ?`,
    [sessionId],
  );
  return rows[0]?.cline_session_id ?? null;
}

/** Enregistre (ou efface avec `null`) le lien vers la session SDK Cline. */
export async function setClineSessionId(
  sessionId: string,
  clineSessionId: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE sessions SET cline_session_id = ? WHERE id = ?`, [
    clineSessionId,
    sessionId,
  ]);
}

/**
 * Lit le mode applicatif de création d'une session (`'ide' | 'ai'`).
 *
 * Renvoie `null` pour une session inexistante ou héritée d'avant la migration :
 * l'appelant retombe alors sur le mode courant, sans jamais échouer.
 */
export async function getSessionAppMode(sessionId: string): Promise<'ide' | 'ai' | null> {
  const db = await getDb();
  const rows = await db.select<{ app_mode: string | null }[]>(
    `SELECT app_mode FROM sessions WHERE id = ?`,
    [sessionId],
  );
  const value = rows[0]?.app_mode;
  return value === 'ide' || value === 'ai' ? value : null;
}

/**
 * Fixe le mode applicatif d'une session. Utilisé en secours pour renseigner une
 * session héritée (app_mode `NULL`) dès que son mode effectif est connu.
 */
export async function setSessionAppMode(sessionId: string, appMode: 'ide' | 'ai'): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE sessions SET app_mode = ? WHERE id = ?`, [appMode, sessionId]);
}
