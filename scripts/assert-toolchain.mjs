import { execFileSync } from 'node:child_process'

const expectedNode = '24.18.0'
const expectedNpm = '11.16.0'
const npmVersion = execFileSync('npm', ['--version'], {
  encoding: 'utf8'
}).trim()

if (process.versions.node !== expectedNode || npmVersion !== expectedNpm) {
  throw new Error(
    [
      `WebTorrent Updated requires Node ${expectedNode} and npm ${expectedNpm}.`,
      `Received Node ${process.versions.node} and npm ${npmVersion}.`,
      'Activate the versions pinned in .nvmrc/.node-version before running project commands.'
    ].join(' ')
  )
}
