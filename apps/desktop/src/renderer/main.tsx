import { focusManager } from "@tanstack/react-query";
import { App } from "@tendril/app";
import ReactDOM from "react-dom/client";

focusManager.setEventListener((handleFocus) => {
	const onFocus = () => handleFocus(true);
	const onBlur = () => handleFocus(false);

	window.addEventListener("focus", onFocus);
	window.addEventListener("blur", onBlur);

	return () => {
		window.removeEventListener("focus", onFocus);
		window.removeEventListener("blur", onBlur);
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
