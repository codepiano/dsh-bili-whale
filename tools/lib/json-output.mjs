// Await the stream callback before any caller exits. console.log + process.exit
// can silently lose the tail of JSON when stdout is a pipe.
export async function writeJson(value, stream=process.stdout) {
  await new Promise((resolve, reject) => stream.write(JSON.stringify(value)+'\n', error => error ? reject(error) : resolve()));
}
