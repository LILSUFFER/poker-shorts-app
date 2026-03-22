import { useState, useEffect } from "react";
import { Switch, Route, useLocation, Link as WouterLink } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import MainPage from "@/pages/main-page";
import NewJob from "@/pages/new-job";
import GeneratePage from "@/pages/generate";
import FilesPage from "@/pages/files";
import ProfileManager from "@/components/profile-manager";
import { Button } from "@/components/ui/button";
import { Plus, Users, Terminal, Copy, Check, Spade, Video, Sparkles, FolderOpen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContentType } from "@shared/schema";

function App() {
  const [location, setLocation] = useLocation();
  const [profileManagerOpen, setProfileManagerOpen] = useState(false);
  const [tagsCopied, setTagsCopied] = useState(false);
  const [igTagsCopied, setIgTagsCopied] = useState(false);
  const [contentType, setContentType] = useState<ContentType>(() => {
    return (localStorage.getItem("contentType") as ContentType) || "poker";
  });

  useEffect(() => {
    localStorage.setItem("contentType", contentType);
  }, [contentType]);

  const isPoker = contentType === "poker";

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <div className="min-h-screen bg-background flex flex-col">
            <header className="border-b bg-card/30 backdrop-blur-sm sticky top-0 z-50">
              <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <WouterLink href="/">
                    <span className="flex items-center gap-2 hover-elevate rounded-md px-2 py-1 cursor-pointer" data-testid="button-logo">
                      <Terminal className="w-4 h-4 text-primary" />
                      <span className="font-medium text-sm tracking-tight" data-testid="text-app-title">
                        shorts.cut
                      </span>
                    </span>
                  </WouterLink>

                  <div className="flex items-center bg-muted rounded-md p-0.5" data-testid="tabs-content-type">
                    <button
                      className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                        isPoker && location !== "/generate" && location !== "/files" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => { setContentType("poker"); setLocation("/"); }}
                      data-testid="tab-poker"
                    >
                      <Spade className="w-3 h-3" />
                      Покер
                    </button>
                    <button
                      className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                        !isPoker && location !== "/generate" && location !== "/files" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => { setContentType("streamer"); setLocation("/"); }}
                      data-testid="tab-streamer"
                    >
                      <Video className="w-3 h-3" />
                      Стримеры
                    </button>
                    <button
                      className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                        location === "/generate" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setLocation("/generate")}
                      data-testid="tab-generate"
                    >
                      <Sparkles className="w-3 h-3" />
                      AI
                    </button>
                    <button
                      className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                        location === "/files" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setLocation("/files")}
                      data-testid="tab-files"
                    >
                      <FolderOpen className="w-3 h-3" />
                      Файлы
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {isPoker && (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              navigator.clipboard.writeText("#покер #покерок #покерок_shorts @POKEROK_Life");
                              setTagsCopied(true);
                              setTimeout(() => setTagsCopied(false), 1500);
                            }}
                            data-testid="button-copy-tags"
                          >
                            {tagsCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                            <span className="ml-1 text-xs">YT/VK</span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>#покер #покерок #покерок_shorts @POKEROK_Life</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              navigator.clipboard.writeText("#покер #покерок #покерок_shorts @pokerok_official");
                              setIgTagsCopied(true);
                              setTimeout(() => setIgTagsCopied(false), 1500);
                            }}
                            data-testid="button-copy-tags-ig"
                          >
                            {igTagsCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                            <span className="ml-1 text-xs">IG</span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>#покер #покерок #покерок_shorts @pokerok_official</TooltipContent>
                      </Tooltip>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setProfileManagerOpen(true)}
                    data-testid="nav-profiles"
                  >
                    <Users className="w-3.5 h-3.5 mr-1.5" />
                    Профили
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => setLocation("/new")}
                    data-testid="nav-new-job"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                    Загрузить
                  </Button>
                </div>
              </div>
            </header>

            <Switch>
              <Route path="/">
                {() => <MainPage contentType={contentType} />}
              </Route>
              <Route path="/new">
                {() => <NewJob contentType={contentType} />}
              </Route>
              <Route path="/video/:id">
                {(params) => <MainPage initialVideoId={params.id} contentType={contentType} />}
              </Route>
              <Route path="/generate">
                {() => <GeneratePage />}
              </Route>
              <Route path="/files">
                {() => <FilesPage />}
              </Route>
              <Route>
                {() => <MainPage contentType={contentType} />}
              </Route>
            </Switch>

            <Toaster />

            {profileManagerOpen && (
              <ProfileManager
                open={profileManagerOpen}
                onOpenChange={setProfileManagerOpen}
              />
            )}
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
