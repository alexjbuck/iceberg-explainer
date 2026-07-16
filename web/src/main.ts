import './style.css'
import { initApp } from './app.js'
import { IcebergExplainer } from './explainer.js'

const explainer = new IcebergExplainer()
await explainer.init()
await initApp(explainer)
