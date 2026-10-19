// Module utilisateur — la validation d'entrée est répétée dans plusieurs
// fonctions. Tâche : extraire cette logique dans un helper exporté.

export function createUser(input) {
  if (!input || typeof input !== "object") throw new Error("invalid input");
  const name = input.name;
  if (typeof name !== "string") throw new Error("fields must be strings");
  if (name.trim() === "") throw new Error("fields must be strings");
  const email = input.email;
  if (typeof email !== "string") throw new Error("fields must be strings");
  if (email.trim() === "") throw new Error("fields must be strings");
  return { name: name.trim(), email: email.trim() };
}

export function updateUser(existing, input) {
  if (!input || typeof input !== "object") throw new Error("invalid input");
  const name = input.name;
  if (typeof name !== "string") throw new Error("fields must be strings");
  if (name.trim() === "") throw new Error("fields must be strings");
  const email = input.email;
  if (typeof email !== "string") throw new Error("fields must be strings");
  if (email.trim() === "") throw new Error("fields must be strings");
  return { ...existing, name: name.trim(), email: email.trim() };
}
