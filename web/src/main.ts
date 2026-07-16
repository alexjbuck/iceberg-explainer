import { initApp } from './app.js'
import { IcebergExplainer } from './explainer.js'

document.body.classList.add('app-ready')

const explainer = new IcebergExplainer()
await explainer.init()
await initApp(explainer)
