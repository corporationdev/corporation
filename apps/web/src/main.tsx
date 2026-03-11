import { App } from "@corporation/app";
import ReactDOM from "react-dom/client";

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(<App adapters={{}} />);
}
