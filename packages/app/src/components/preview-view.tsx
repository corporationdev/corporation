import { GlobeIcon, RefreshCwIcon } from "lucide-react";
import {
	type FC,
	type KeyboardEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PreviewViewProps = {
	url: string;
};

export const PreviewView: FC<PreviewViewProps> = ({ url }) => {
	const [currentUrl, setCurrentUrl] = useState(url);
	const [inputValue, setInputValue] = useState(url);
	const iframeRef = useRef<HTMLIFrameElement>(null);

	const navigate = useCallback((targetUrl: string) => {
		setCurrentUrl(targetUrl);
		setInputValue(targetUrl);
	}, []);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			navigate(inputValue);
		}
	};

	const handleRefresh = () => {
		const iframe = iframeRef.current;
		if (iframe) {
			iframe.src = currentUrl;
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
				<GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<Input
					className="h-7 flex-1 rounded-sm border-none bg-muted/50 text-xs focus-visible:ring-0"
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={handleKeyDown}
					value={inputValue}
				/>
				<Button
					className="size-7 shrink-0"
					onClick={handleRefresh}
					size="icon"
					variant="ghost"
				>
					<RefreshCwIcon className="size-3.5" />
					<span className="sr-only">Refresh</span>
				</Button>
			</div>
			<iframe
				allow="clipboard-read; clipboard-write"
				className="min-h-0 flex-1 border-0"
				ref={iframeRef}
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
				src={currentUrl}
				title="Preview"
			/>
		</div>
	);
};
