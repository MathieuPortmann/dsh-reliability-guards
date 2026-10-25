// Reliability guards — Client half (Web UI).
// Under every turn with a finding (`conversation.chat.turnTail`): what the
// reliability check saw and whether the AI corrected it. Texts in English and
// French through the locale service; colors from the host theme tokens.
window.__ModuleLoader__.load({
  id: 'dsh-reliability-guards',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'reliability-guards';
    const KEY = 'reliabilityGuards';

    const en = {
      'title': 'Reliability check',
      'action.corrected': 'corrected by the AI',
      'action.warned': 'still present after a reminder',
      'action.detected': 'to check',
      'code.falseSuccess': 'The answer announced a success, but the tool "{detail}" had failed.',
      'code.announcedOnly': 'The AI announced an action ("{detail}") without doing it.',
      'code.actionWithoutTool': 'The answer says "{detail}", but no tool was used: nothing was actually done or checked.',
      'code.deniedCapability': 'The AI said it could not do it ("{detail}") although the needed tools were available.',
      'code.unverifiedDoi': 'DOI(s) read in no source during this conversation: {detail}',
      'code.foreignScript': 'The answer contained foreign characters.',
      'code.emoji': 'The answer contained emojis.',
      'code.frenchSpelling': 'Possible French spelling mistakes: {detail}',
      'code.cutAnswer': 'The answer seemed cut off.',
      'code.markupLeak': 'The answer contained a tool call written as text (nothing was executed).',
      'explain.on': 'Explain mode: read-only (type /explain off to allow changes)',
    };
    const fr = {
      'title': 'Vérification de fiabilité',
      'action.corrected': 'corrigé par l’IA',
      'action.warned': 'toujours présent après un rappel',
      'action.detected': 'à vérifier',
      'code.falseSuccess': 'La réponse annonçait un succès, alors que l’outil « {detail} » avait échoué.',
      'code.announcedOnly': 'L’IA a annoncé une action (« {detail} ») sans la faire.',
      'code.actionWithoutTool': 'La réponse dit « {detail} », mais aucun outil n’a été utilisé : rien n’a réellement été fait ni vérifié.',
      'code.deniedCapability': 'L’IA a dit ne pas pouvoir le faire (« {detail} ») alors que les outils nécessaires étaient disponibles.',
      'code.unverifiedDoi': 'DOI lu(s) dans aucune source pendant la discussion (à vérifier) : {detail}',
      'code.foreignScript': 'La réponse contenait des caractères étrangers.',
      'code.emoji': 'La réponse contenait des emojis.',
      'code.frenchSpelling': 'Fautes d’orthographe possibles : {detail}',
      'code.cutAnswer': 'La réponse semblait coupée.',
      'code.markupLeak': 'La réponse contenait un appel d’outil écrit en texte (rien n’a été exécuté).',
      'explain.on': 'Mode explication : lecture seule (tape /explain off pour autoriser les modifications)',
    };

    const color = action => (action === 'corrected' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-warn-primary)');

    function TurnChecks({ turn, useProjection, t }) {
      const v = typeof useProjection === 'function' ? useProjection(KEY) : undefined;
      const rec = v?.turns?.find(x => x.turn === turn?.turn);
      if (!rec || !rec.findings?.length) return null;
      return h('div', { 'data-reliability-guards': 'turn', style: { margin: '4px 0', fontSize: 12, overflowWrap: 'anywhere' } },
        h('div', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('title')),
        h('ul', { style: { margin: '2px 0 0', paddingLeft: 16 } },
          rec.findings.map((f, i) => h('li', { key: i, style: { color: color(f.action) } },
            f.action === 'corrected' ? t(`code.${f.code}`, { detail: '' }).replace(/\s*[«"]\s*[»"]/, '') : t(`code.${f.code}`, { detail: f.detail }),
            ` (${t(`action.${f.action}`)})`))));
    }

    function ExplainBadge({ useProjection, t }) {
      const v = typeof useProjection === 'function' ? useProjection(KEY) : undefined;
      if (!v?.explain) return null;
      return h('span', { 'data-reliability-guards': 'explain', style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'nowrap' } }, t('explain.on'));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // French is not shipped by the Harness; another local plugin may already have added it.
        ctx.effect(() => {
          try { return ctx.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }); } catch { return () => {}; }
        }, 'reliability-guards: french language');
        ctx.effect(() => ctx.locale.register(NS, { zh: en, en }), 'reliability-guards: dictionaries');
        ctx.effect(() => {
          try { return ctx.locale.register(NS, 'fr', fr); } catch { return () => {}; }
        }, 'reliability-guards: french dictionary');
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: 'dsh-reliability-guards', order: 30, locale: NS,
        }, TurnChecks));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-reliability-guards', order: 30, locale: NS,
        }, ExplainBadge));
      },
    };
  },
});
