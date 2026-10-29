import { describe, it, expect } from 'vitest';
import { extensionOf, fileKindOf, imageMimeOf, mediaMimeOf, isBinaryReadable } from '../fileKind';

/**
 * Classification des fichiers par extension : ces tests figent la décision
 * « quel mode de rendu » (texte / image / pdf / vidéo / audio / binaire) pour
 * éviter toute régression dans le routage de l'éditeur.
 */
describe('extensionOf', () => {
  it('extrait l’extension en minuscules', () => {
    expect(extensionOf('/a/b/Photo.PNG')).toBe('png');
    expect(extensionOf('C:\\dir\\Clip.MP4')).toBe('mp4');
  });

  it('renvoie une chaîne vide pour un fichier sans extension ou caché', () => {
    expect(extensionOf('/a/Makefile')).toBe('');
    expect(extensionOf('/a/.gitignore')).toBe('');
  });
});

describe('fileKindOf', () => {
  it('classe les images (SVG inclus)', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']) {
      expect(fileKindOf(`/f.${ext}`)).toBe('image');
    }
  });

  it('classe le PDF', () => {
    expect(fileKindOf('/doc.pdf')).toBe('pdf');
  });

  it('classe les vidéos lues par la webview', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv']) {
      expect(fileKindOf(`/v.${ext}`)).toBe('video');
    }
  });

  it('classe les audios lus par la webview', () => {
    for (const ext of ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus']) {
      expect(fileKindOf(`/a.${ext}`)).toBe('audio');
    }
  });

  it('classe les binaires sans lecteur (archives, bureautique, formats exotiques)', () => {
    for (const ext of ['zip', '7z', 'docx', 'xlsx', 'pptx', 'avi', 'exe', 'dll', 'ttf', 'sqlite']) {
      expect(fileKindOf(`/b.${ext}`)).toBe('binary');
    }
  });

  it('traite le texte et les sentinelles comme « text »', () => {
    expect(fileKindOf('/main.ts')).toBe('text');
    expect(fileKindOf('__untitled__1')).toBe('text');
    expect(fileKindOf('__preview__')).toBe('text');
    expect(fileKindOf(null)).toBe('text');
  });
});

describe('imageMimeOf', () => {
  it('renvoie les bons types MIME', () => {
    expect(imageMimeOf('/a.svg')).toBe('image/svg+xml');
    expect(imageMimeOf('/a.jpg')).toBe('image/jpeg');
    expect(imageMimeOf('/a.jpeg')).toBe('image/jpeg');
    expect(imageMimeOf('/a.ico')).toBe('image/x-icon');
    expect(imageMimeOf('/a.png')).toBe('image/png');
    expect(imageMimeOf('/a.unknown')).toBe('image/png');
  });
});

describe('mediaMimeOf', () => {
  it('renvoie les bons types MIME vidéo/audio', () => {
    expect(mediaMimeOf('/v.webm')).toBe('video/webm');
    expect(mediaMimeOf('/v.mov')).toBe('video/quicktime');
    expect(mediaMimeOf('/v.mp4')).toBe('video/mp4');
    expect(mediaMimeOf('/a.wav')).toBe('audio/wav');
    expect(mediaMimeOf('/a.flac')).toBe('audio/flac');
    expect(mediaMimeOf('/a.mp3')).toBe('audio/mpeg');
  });
});

describe('isBinaryReadable', () => {
  it('vrai pour les médias à lecteur dédié', () => {
    expect(isBinaryReadable('/a.png')).toBe(true);
    expect(isBinaryReadable('/a.pdf')).toBe(true);
    expect(isBinaryReadable('/a.mp4')).toBe(true);
    expect(isBinaryReadable('/a.mp3')).toBe(true);
  });

  it('faux pour le texte et les binaires sans lecteur', () => {
    expect(isBinaryReadable('/a.ts')).toBe(false);
    expect(isBinaryReadable('/a.zip')).toBe(false);
    expect(isBinaryReadable('/a.exe')).toBe(false);
  });
});
