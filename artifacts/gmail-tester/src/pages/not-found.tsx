import { useState } from "react"
import { AlertCircle, FileWarning } from "lucide-react"

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4 text-foreground">
      <div className="max-w-md w-full border border-border bg-card rounded-lg shadow-sm p-6 flex flex-col items-center text-center space-y-4">
        <FileWarning className="w-12 h-12 text-muted-foreground" />
        <h1 className="text-xl font-bold font-mono uppercase tracking-wider text-muted-foreground">404 - Not Found</h1>
        <p className="text-sm text-muted-foreground">
          The requested route was not found in the application.
        </p>
      </div>
    </div>
  )
}
