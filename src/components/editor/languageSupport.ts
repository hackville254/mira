/**
 * Façade de coloration / labellisation, adossée au registre unique
 * (`src/lib/languages.ts`). Conservé pour ne pas casser les imports existants
 * (Editor, AiDiffPane, App…) tout en garantissant une source de vérité unique.
 */
export {
  getLanguageExtension,
  languageLabel,
  resolveLanguage,
} from '../../lib/languages';
