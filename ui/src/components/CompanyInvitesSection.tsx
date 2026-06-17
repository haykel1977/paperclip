import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { queryKeys } from "../lib/queryKeys";
import { accessApi } from "../api/access";
import type { HumanCompanyRole } from "../api/access";

interface Props {
  companyId: string;
}

const ROLES: HumanCompanyRole[] = ["operator", "admin", "viewer", "owner"];
type InviteRole = HumanCompanyRole;

/**
 * Invites section for CompanySettings.
 *
 * Renders:
 *   data-testid="company-settings-invites-section"   — section wrapper
 *   data-testid="company-settings-create-human-invite" — create invite button
 *   data-testid="company-settings-human-invite-role"  — role select
 *   data-testid="company-settings-human-invite-url"   — generated invite URL
 */
export function CompanyInvitesSection({ companyId }: Props) {
  const queryClient = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<InviteRole>("operator");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: invitesData } = useQuery({
    queryKey: queryKeys.access.invites(companyId, "active"),
    queryFn: () => accessApi.listInvites(companyId, { state: "active" }),
    staleTime: 30_000,
  });

  const createInviteMutation = useMutation({
    mutationFn: (role: InviteRole) =>
      accessApi.createCompanyInvite(companyId, { allowedJoinTypes: "human", humanRole: role }),
    onSuccess: (invite) => {
      setInviteUrl(`${window.location.origin}/invite/${invite.token}`);
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.access.invites(companyId, "active"),
      });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });

  function handleCreate() {
    setInviteUrl(null);
    createInviteMutation.mutate(selectedRole);
  }

  return (
    <div className="space-y-4" data-testid="company-settings-invites-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Human Invites
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <p className="text-sm text-muted-foreground">
          Invite a human collaborator to join this company.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value as InviteRole)}
            data-testid="company-settings-human-invite-role"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createInviteMutation.isPending}
            data-testid="company-settings-create-human-invite"
          >
            {createInviteMutation.isPending ? "Creating…" : "Create invite"}
          </Button>
        </div>

        {inviteUrl && (
          <div
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
            data-testid="company-settings-human-invite-url"
          >
            <span className="truncate font-mono text-xs">{inviteUrl}</span>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-xs"
              onClick={() => void navigator.clipboard.writeText(inviteUrl)}
            >
              Copy
            </Button>
          </div>
        )}

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        {invitesData && invitesData.invites.length > 0 && (
          <div className="space-y-1 pt-1">
            <p className="text-xs text-muted-foreground">
              Active invites ({invitesData.invites.length})
            </p>
            {invitesData.invites.slice(0, 5).map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="font-medium capitalize">{inv.humanRole ?? "operator"}</span>
                <span className="truncate font-mono opacity-60">{inv.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
