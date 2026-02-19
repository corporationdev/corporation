import { App } from "@corporation/app";
import { focusManager } from "@tanstack/react-query";
import ReactDOM from "react-dom/client";

focusManager.setEventListener((handleFocus) => {
	window.addEventListener("focus", () => handleFocus(true));
	window.addEventListener("blur", () => handleFocus(false));
	return () => {
		window.removeEventListener("focus", () => handleFocus(true));
		window.removeEventListener("blur", () => handleFocus(false));
	};
});

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(<App adapters={{}} />);
}
