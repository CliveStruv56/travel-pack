// Usage: npm run connect-link -- <app url> <server url> <name> <token>
// Prints the link that connects one phone to the server as <name>. The token
// must match that person's entry in the server's USERS setting. Treat the link
// like a password: anyone holding it can read and edit shared trips.
const [app, url, name, token] = process.argv.slice(2);
if (!app || !url || !name || !token) {
  console.error('Usage: npm run connect-link -- <app url> <server url> <name> <token>');
  process.exit(1);
}
const data = Buffer.from(JSON.stringify({ u: url.replace(/\/$/, ''), t: token, n: name })).toString('base64url');
console.log(`${app.replace(/#.*$/, '')}#connect=${data}`);
