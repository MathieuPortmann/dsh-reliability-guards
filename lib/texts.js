// Texts and word lists of dsh-reliability-guards, kept apart from the rules so
// they can be read and translated without touching the detection code.
//
// Placeholders in {braces} are filled by `fill()` (lib/rules.js):
//   NUDGE      sent to the model (English): {tool} {error} {excerpt} {tools}
//              {lines} {sample} {words} {tail}
//   USER_TEXT  shown to the user under the answer and in approval cards
//              (English and French): {detail} {why} {path}

/** Reminders injected into the conversation, one per finding code. */
export const NUDGE = Object.freeze({
  falseSuccess: `Reliability check: your answer says the task succeeded, but a tool result shows a failure that was never fixed.
Tool: {tool}
Result: {error}
Rewrite your answer now: tell the user plainly what failed and what was really done. Do not claim success. Run another tool only if it is needed to fix the failure.`,
  announcedOnly: `You announced an action ("{excerpt}") but did not do it: no tool was called in this turn. Do it now with a real tool call. If you cannot, tell the user plainly why. Do not announce it again.`,
  actionWithoutTool: `Reliability check: your answer says "{excerpt}", but you called no tool in this turn, so nothing was done or checked. Either do it now with the right tool, or correct your answer and say that you have not done it.`,
  deniedCapability: `Reliability check: you said "{excerpt}", but these tools are available to you right now: {tools}. Use them to do what the user asked, or explain precisely why none of them fits. Never present a missing or unused tool as a limit of the platform.`,
  unverifiedDoi: `Reliability check: these DOIs appear in no tool result of this conversation and were checked by the harness:
{lines}
Remove every DOI marked NOT FOUND (it is probably invented) and say that you could not verify it. Never write a DOI you did not read in a tool result.`,
  foreignScript: `Your answer contains Chinese/Japanese characters ("{sample}"). Rewrite your whole answer in the user's language, without them.`,
  emoji: `Your answer contains emojis ("{sample}"). This conversation asked for plain text without emojis (they can break the user's notes and tools). Rewrite your whole answer without any emoji or pictogram; plain words or a simple list are enough. Do not mention this reminder.`,
  frenchSpelling: `French spell check: these words of your answer are misspelled or are not French words.
MISSPELLED: {words}
Rewrite your whole answer in correct French: fix each of these words (spelling, agreement), and if you are not sure of a word, use a simpler common French word. Keep names and technical terms that are correct. Do not mention this reminder.`,
  cutAnswer: `Your answer stopped in the middle; it ends with: "…{tail}". If you announced an action (for example "let me check:" or "je vais vérifier :"), do it now with a real tool call instead of describing it. Otherwise continue the answer exactly from where it stopped, without repeating what you already wrote and without any comment about the interruption.`,
  markupLeak: `Your answer contains raw markup ("{sample}"): a tool call or your reasoning was written as text, so nothing was executed. If you meant to call a tool, call it now with a real tool call. Otherwise rewrite your answer for the user without any of this markup.`,
});

/** Messages for the user. French is an intentional translation of the English set. */
export const USER_TEXT = {
  en: {
    falseSuccess: 'The answer announced a success, but the tool "{detail}" had failed.',
    announcedOnly: 'The AI announced an action ("{detail}") without doing it.',
    actionWithoutTool: 'The answer says "{detail}", but no tool was used: nothing was actually done or checked.',
    deniedCapability: 'The AI said it could not do it ("{detail}") although the needed tools were available.',
    unverifiedDoi: 'DOI(s) not read in any source during this conversation (check them): {detail}',
    foreignScript: 'The answer contained foreign characters.',
    emoji: 'The answer contained emojis.',
    frenchSpelling: 'Possible French spelling mistakes: {detail}',
    cutAnswer: 'The answer seemed cut off.',
    markupLeak: 'The answer contained a tool call written as text (nothing was executed).',
    corrected: 'Checked and corrected by the AI after a reliability reminder.',
    title: 'Reliability check',
    destructive: 'Destructive command ({why}): {detail}',
    overwriteFile: 'Overwrite the existing file {path} entirely',
    why: {
      delete: 'deletes files',
      move: 'moves or renames files',
      git: 'discards git history or changes',
      disk: 'writes to a disk or truncates',
      overwrite: 'overwrites an existing file',
    },
  },
  fr: {
    falseSuccess: 'La réponse annonçait un succès, alors que l’outil « {detail} » avait échoué.',
    announcedOnly: 'L’IA a annoncé une action (« {detail} ») sans la faire.',
    actionWithoutTool: 'La réponse dit « {detail} », mais aucun outil n’a été utilisé : rien n’a réellement été fait ni vérifié.',
    deniedCapability: 'L’IA a dit ne pas pouvoir le faire (« {detail} ») alors que les outils nécessaires étaient disponibles.',
    unverifiedDoi: 'DOI lu(s) dans aucune source pendant la discussion (à vérifier) : {detail}',
    foreignScript: 'La réponse contenait des caractères étrangers.',
    emoji: 'La réponse contenait des emojis.',
    frenchSpelling: 'Fautes d’orthographe possibles : {detail}',
    cutAnswer: 'La réponse semblait coupée.',
    markupLeak: 'La réponse contenait un appel d’outil écrit en texte (rien n’a été exécuté).',
    corrected: 'Vérifié et corrigé par l’IA après un rappel de fiabilité.',
    title: 'Vérification de fiabilité',
    destructive: 'Commande destructrice ({why}) : {detail}',
    overwriteFile: 'Écraser entièrement le fichier existant {path}',
    why: {
      delete: 'supprime des fichiers',
      move: 'déplace ou renomme des fichiers',
      git: 'efface des modifications ou de l’historique git',
      disk: 'écrit sur un disque ou tronque',
      overwrite: 'écrase un fichier existant',
    },
  },
};

/**
 * Words that neither the French nor the English dictionary knows but that are
 * right in technical answers (lower case, whitespace separated). Extend it with
 * the `spellAllow` setting instead of editing this list.
 */
export const SPELL_ALLOW = `
aujourdhui todo sudo json yaml sqlite systemd localhost github markdown pdf docx xlsx pptx
bash zsh shell prompt prompts plugin plugins skill skills token tokens chatbot email emails
backlog workflow workflows dataset datasets online offline timeout cache config webapp
frontend backend rust cargo crate crates tokio serde actix async benchmark benchmarks
dsh deepseek ollama qwen llama vllm gguf quantisation quantisations quantization quantized
tuné tunée tunés tunées finetuning crossref openalex flatpak nvidia linux python javascript
typescript nodejs docker kubernetes webhook webhooks regex stdout stderr stdin hostname
username
`;

/**
 * Tools that stay available while the read-only /explain mode is on: reads,
 * searches and *_propose tools (nothing is written until the user approves).
 * Every other tool is refused, including tools added later. Names are compared
 * without an "mcp__<server>__" prefix. Names of tools from companion plugins
 * that are not installed simply never match.
 */
export const EXPLAIN_ALLOW = Object.freeze([
  'read', 'read_image', 'glob', 'grep', 'pdf_read',
  'web', 'web_search', 'web_fetch',
  'conversation_search', 'runtime_health', 'skill', 'present', 'ask_user_question', 'todo_write',
  'list_agents', 'job_list', 'job_output', 'get_goal',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'logseq_graphs', 'logseq_list', 'logseq_query', 'logseq_search', 'logseq_show', 'logseq_todo_count',
  'zotero_collections', 'zotero_fulltext', 'zotero_item', 'zotero_libraries', 'zotero_notes',
  'zotero_note_read', 'zotero_recent', 'zotero_search', 'zotero_tags',
  'openalex_search', 'openalex_work', 'doi_verify', 'wos_search', 'retrace',
  'memory_propose', 'task_propose', 'task_list', 'logseq_propose', 'zotero_propose_note',
  'document_propose', 'plan_show',
]);
