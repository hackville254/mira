// Module post — makePost() doit exposer un `slug` calculé via slugify(title).

/**
 * Construit un objet post minimal.
 * État initial : ne renvoie que title/body. La tâche demande d'ajouter `slug`.
 */
export function makePost(title, body) {
  return { title, body };
}
