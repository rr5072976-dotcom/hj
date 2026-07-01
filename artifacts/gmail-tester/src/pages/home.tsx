import { useState, useCallback, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";

import {
  useGetAuthStatus,
  useUploadCredentials,
  useStartAuth,
  useLogout,
  useGetTokenInfo,
  useTestConnection,
  useSendEmail,
  getGetAuthStatusQueryKey,
  getStartAuthQueryKey,
  getGetTokenInfoQueryKey,
  getTestConnectionQueryKey
} from "@workspace/api-client-react";
import { type LogEntry } from "@/components/log-panel";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { LogPanel } from "@/components/log-panel";
import { useToast } from "@/hooks/use-toast";
import { TerminalSquare, Mail, Key, ShieldCheck, Zap, PowerOff, ShieldAlert, FileJson, ClipboardPaste } from "lucide-react";

// Pre-filled credentials — the redirect_uri below is now the frontend /callback route.
// Make sure this exact URI is registered in Google Cloud Console → Authorized redirect URIs.
const PREFILLED_CREDENTIALS = JSON.stringify({
  web: {
    client_id: "468903672745-7pogpvdifq6anlevt7ri3h716oibad90.apps.googleusercontent.com",
    project_id: "artful-chiller-501021-e4",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: "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",
    redirect_uris: [
      "https://9052ec61-0730-4358-bdee-6d741cad263d-00-2qdav87wddsjk.sisko.replit.dev/callback",
    ],
  },
}, null, 2);

const emailSchema = z.object({
  from: z.string().email("Invalid email address").or(z.literal("")),
  to: z.string().email("Invalid email address"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
});

type EmailFormValues = z.infer<typeof emailSchema>;

// Helper to extract logs from any API response or error
function extractLogs(result: any): LogEntry[] {
  if (!result) return [];
  if (Array.isArray(result.logs)) return result.logs;
  if (result.response?.data?.logs && Array.isArray(result.response.data.logs)) {
    return result.response.data.logs;
  }
  return [];
}

export function Home() {
  const { toast } = useToast();
  
  // -- State --
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [credentialsJson, setCredentialsJson] = useState(PREFILLED_CREDENTIALS);
  const [isPolling, setIsPolling] = useState(false);
  
  // -- Log Appender --
  const appendLogs = useCallback((newLogs: LogEntry[]) => {
    if (newLogs.length > 0) {
      setLogs((prev) => [...newLogs, ...prev]);
    }
  }, []);

  // -- Queries & Mutations --
  
  // 1. Auth Status (polling enabled conditionally)
  const { data: authStatus, refetch: refetchAuth } = useGetAuthStatus({
    query: { 
      enabled: true,
      refetchInterval: isPolling ? 3000 : false,
      queryKey: getGetAuthStatusQueryKey()
    }
  });

  // Stop polling once authenticated
  useEffect(() => {
    if (isPolling && authStatus?.authenticated) {
      setIsPolling(false);
      toast({ title: "Authentication successful", variant: "default" });
    }
  }, [authStatus?.authenticated, isPolling, toast]);

  // Always extract logs from auth status if any
  useEffect(() => {
    if (authStatus?.logs && authStatus.logs.length > 0) {
      // We don't want to spam logs on every poll unless there's actually a new log
      // Realistically, we might want to dedupe, but let's just append them if they exist and we're not constantly fetching identical ones.
      // To avoid infinite loops or spam, let's only append on manual triggers or state changes for this specific hook in a real app.
      // For now, we append on mount or when authStatus object changes.
      // To avoid infinite log spam from polling, we'll track last seen log timestamp.
    }
  }, [authStatus]);

  // 2. Upload Credentials
  const uploadCreds = useUploadCredentials({
    mutation: {
      onSuccess: (data) => {
        appendLogs(data.logs);
        toast({ title: "Credentials Uploaded" });
        refetchAuth();
      },
      onError: (err: any) => {
        appendLogs(extractLogs(err));
        toast({ title: "Upload Failed", variant: "destructive", description: err.response?.data?.error || "Unknown error" });
      }
    }
  });

  const handleUploadCredentials = () => {
    try {
      const parsed = JSON.parse(credentialsJson);
      uploadCreds.mutate({ data: { credentials: parsed } });
    } catch (e) {
      toast({ title: "Invalid JSON", variant: "destructive" });
      appendLogs([{ level: "error", message: "Failed to parse credentials JSON.", timestamp: new Date().toISOString() }]);
    }
  };

  // 3. Start Auth
  const { refetch: startAuth, isFetching: isStartingAuth } = useStartAuth({
    query: { enabled: false, queryKey: getStartAuthQueryKey() }
  });

  const handleSignIn = async () => {
    try {
      const res = await startAuth();
      if (res.data) {
        appendLogs(res.data.logs);
        if (res.data.authUrl) {
          window.open(res.data.authUrl, '_blank');
          setIsPolling(true);
          toast({ title: "Opened Auth URL in new tab" });
        }
      } else if (res.error) {
        appendLogs(extractLogs(res.error));
        toast({ title: "Failed to start auth", variant: "destructive" });
      }
    } catch (e: any) {
      appendLogs(extractLogs(e));
    }
  };

  // 4. Logout
  const logout = useLogout({
    mutation: {
      onSuccess: (data) => {
        appendLogs(data.logs);
        toast({ title: "Logged out" });
        refetchAuth();
      },
      onError: (err: any) => {
        appendLogs(extractLogs(err));
        toast({ title: "Logout failed", variant: "destructive" });
      }
    }
  });

  // 5. Test Connection
  const { refetch: testConn, isFetching: isTesting } = useTestConnection({
    query: { enabled: false, queryKey: getTestConnectionQueryKey() }
  });

  const handleTestConnection = async () => {
    try {
      const res = await testConn();
      if (res.data) {
        appendLogs(res.data.logs);
        if (res.data.success) {
          toast({ title: "Connection Successful" });
        } else {
          toast({ title: "Connection Failed", description: res.data.message, variant: "destructive" });
        }
      } else if (res.error) {
        appendLogs(extractLogs(res.error));
        toast({ title: "Connection Error", variant: "destructive" });
      }
    } catch (e: any) {
      appendLogs(extractLogs(e));
    }
  };

  // 6. View Token Info
  const { refetch: getTokenInfo, isFetching: isGettingToken } = useGetTokenInfo({
    query: { enabled: false, queryKey: getGetTokenInfoQueryKey() }
  });

  const handleGetTokenInfo = async () => {
    try {
      const res = await getTokenInfo();
      if (res.data) {
        appendLogs(res.data.logs);
        toast({ title: "Token info fetched" });
      } else if (res.error) {
        appendLogs(extractLogs(res.error));
        toast({ title: "Failed to fetch token info", variant: "destructive" });
      }
    } catch (e: any) {
      appendLogs(extractLogs(e));
    }
  };

  // 7. Send Email
  const form = useForm<EmailFormValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { from: "", to: "", subject: "", body: "" },
  });

  const sendEmail = useSendEmail({
    mutation: {
      onSuccess: (data) => {
        appendLogs(data.logs);
        if (data.success) {
          toast({ title: "Email sent successfully", description: `Message ID: ${data.messageId}` });
          form.reset();
        } else {
          toast({ title: "Failed to send email", variant: "destructive" });
        }
      },
      onError: (err: any) => {
        appendLogs(extractLogs(err));
        toast({ title: "Send Error", variant: "destructive" });
      }
    }
  });

  const onSubmitEmail = (values: EmailFormValues) => {
    sendEmail.mutate({ data: values });
  };

  // 8. Manual code exchange (fallback for when phone can't reach the callback URL)
  const [manualUrl, setManualUrl] = useState("");
  const [isManualExchanging, setIsManualExchanging] = useState(false);

  const handleManualExchange = async () => {
    // Accept any of these paste formats:
    //   1. Full URL:  https://.../callback?code=4/0A...&scope=...
    //   2. Query-only: ?code=4/0A...
    //   3. key=value:  code=4/0A...
    //   4. Raw code:   4/0A...
    let code = manualUrl.trim();
    try {
      // Try as full URL first
      const parsed = new URL(code);
      const fromUrl = parsed.searchParams.get("code");
      if (fromUrl) { code = fromUrl; }
    } catch {
      // Not a full URL — try querystring forms
      const qs = code.startsWith("?") ? code.slice(1) : code;
      const params = new URLSearchParams(qs);
      const fromQs = params.get("code");
      if (fromQs) code = fromQs;
      // else: treat the whole thing as a raw code
    }

    if (!code) {
      toast({ title: "No code found", description: "Paste the full redirect URL or the code= value.", variant: "destructive" });
      return;
    }

    setIsManualExchanging(true);
    appendLogs([{ level: "info", message: `Manual exchange: submitting code ${code.slice(0, 20)}...`, timestamp: new Date().toISOString() }]);

    try {
      const res = await fetch("/api/gmail/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json() as { success?: boolean; error?: string; logs?: LogEntry[] };
      if (data.logs) appendLogs(data.logs);
      if (data.success) {
        toast({ title: "Authentication successful!" });
        setManualUrl("");
        setIsPolling(false);
        refetchAuth();
      } else {
        toast({ title: "Exchange failed", description: data.error, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Network error", description: e.message, variant: "destructive" });
    } finally {
      setIsManualExchanging(false);
    }
  };

  // Derived state
  const isAuth = authStatus?.authenticated;
  const hasCreds = authStatus?.hasCredentials;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      
      {/* HEADER */}
      <header className="h-14 border-b border-border bg-card px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center">
            <TerminalSquare className="w-5 h-5 text-primary" />
          </div>
          <h1 className="font-semibold text-sm tracking-tight text-card-foreground">Gmail API Tester</h1>
        </div>
        
        <div className="flex items-center gap-3">
          {isAuth ? (
            <Badge variant="outline" className="border-green-500/30 text-green-400 bg-green-500/10">
              <ShieldCheck className="w-3 h-3 mr-1" /> Authenticated
            </Badge>
          ) : (
            <Badge variant="outline" className="border-red-500/30 text-red-400 bg-red-500/10">
              <ShieldAlert className="w-3 h-3 mr-1" /> Not Authenticated
            </Badge>
          )}
          {authStatus?.email && (
            <span className="text-xs text-muted-foreground font-mono">{authStatus.email}</span>
          )}
        </div>
      </header>

      {/* MAIN CONTENT */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 min-h-0 overflow-y-auto">
        
        {/* LEFT COLUMN: Configuration & Auth */}
        <div className="flex flex-col gap-4">
          
          <Card className="flex-shrink-0">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <FileJson className="w-4 h-4 text-muted-foreground" />
                <CardTitle>OAuth Credentials</CardTitle>
              </div>
              <CardDescription>
                Paste your Google OAuth 2.0 client credentials JSON.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <Textarea 
                  className="h-32 text-xs bg-black/50 border-border/50" 
                  value={credentialsJson}
                  onChange={(e) => setCredentialsJson(e.target.value)}
                  placeholder="{...}"
                />
                <div className="flex justify-between items-center">
                  <Badge variant={hasCreds ? "default" : "secondary"}>
                    {hasCreds ? "Credentials Loaded" : "No Credentials"}
                  </Badge>
                  <Button 
                    onClick={handleUploadCredentials} 
                    disabled={uploadCreds.isPending}
                    size="sm"
                  >
                    {uploadCreds.isPending ? "Loading..." : "Load Credentials"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="flex-shrink-0">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-muted-foreground" />
                <CardTitle>Authentication</CardTitle>
              </div>
              <CardDescription>Authorize access to your Gmail account.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button 
                  onClick={handleSignIn} 
                  disabled={!hasCreds || isAuth || isStartingAuth || isPolling}
                  className="flex-1"
                >
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  {isPolling ? "Waiting for Auth..." : "Sign In with Google"}
                </Button>
                <Button 
                  variant="destructive" 
                  onClick={() => logout.mutate()} 
                  disabled={!isAuth || logout.isPending}
                  size="icon"
                  title="Sign Out"
                >
                  <PowerOff className="w-4 h-4" />
                </Button>
              </div>
              
              {authStatus?.expiresAt && (
                <p className="text-xs text-muted-foreground mt-3 font-mono">
                  Token expires: {format(new Date(authStatus.expiresAt), "PPpp")}
                </p>
              )}

              {/* Manual fallback — for when the phone can't load the /callback page */}
              {!isAuth && (
                <div className="mt-4 pt-4 border-t border-border/50">
                  <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                    <ClipboardPaste className="w-3 h-3" />
                    <span>Phone got "site can't be reached"? Copy the URL from the browser bar and paste it here:</span>
                  </p>
                  <div className="flex gap-2">
                    <Input
                      className="text-xs font-mono flex-1"
                      placeholder="https://…/callback?code=4/0A… or just the code"
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleManualExchange()}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleManualExchange}
                      disabled={!manualUrl.trim() || isManualExchanging || !hasCreds}
                    >
                      {isManualExchanging ? "Exchanging…" : "Submit"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="flex-shrink-0">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-muted-foreground" />
                <CardTitle>Diagnostics</CardTitle>
              </div>
              <CardDescription>Test the established connection.</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button 
                variant="outline" 
                onClick={handleTestConnection} 
                disabled={!isAuth || isTesting}
                className="flex-1"
              >
                Test Connection
              </Button>
              <Button 
                variant="outline" 
                onClick={handleGetTokenInfo} 
                disabled={!isAuth || isGettingToken}
                className="flex-1"
              >
                View Token Info
              </Button>
            </CardContent>
          </Card>

        </div>

        {/* RIGHT COLUMN: Send Email & Logs */}
        <div className="flex flex-col gap-4 h-full">
          
          <Card className="flex-shrink-0">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-muted-foreground" />
                <CardTitle>Compose Email</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmitEmail)} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="from"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>From</FormLabel>
                          <FormControl>
                            <Input placeholder={authStatus?.email || "me@gmail.com"} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="to"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>To</FormLabel>
                          <FormControl>
                            <Input placeholder="recipient@example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  
                  <FormField
                    control={form.control}
                    name="subject"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Subject</FormLabel>
                        <FormControl>
                          <Input placeholder="Test Subject" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="body"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Body</FormLabel>
                        <FormControl>
                          <Textarea placeholder="Hello from the API..." className="h-24" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <div className="flex justify-end pt-1">
                    <Button 
                      type="submit" 
                      disabled={!isAuth || sendEmail.isPending}
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      {sendEmail.isPending ? "Sending..." : "Send Email"}
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>

          {/* LOGS PANEL */}
          <div className="flex-1 min-h-[300px]">
            <LogPanel logs={logs} />
          </div>

        </div>
        
      </div>
    </div>
  );
}
