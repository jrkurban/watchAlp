import React from 'react';
import { Ban, Shield, ShieldOff, UserX, X } from 'lucide-react';
import type { BannedUser, RoomMember } from '../lib/roomRoles';

type Props = {
  members: RoomMember[];
  banned: BannedUser[];
  isAdmin: boolean;
  currentUid: string;
  onClose: () => void;
  onGrantAdmin: (uid: string) => void;
  onRevokeAdmin: (uid: string) => void;
  onBan: (member: RoomMember) => void;
  onUnban: (uid: string) => void;
};

export function RoomMembers({
  members,
  banned,
  isAdmin,
  currentUid,
  onClose,
  onGrantAdmin,
  onRevokeAdmin,
  onBan,
  onUnban,
}: Props) {
  return (
    <div className="fixed inset-0 bg-stone-900/50 dark:bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-stone-900 rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh] border border-transparent dark:border-stone-800">
        <div className="px-6 py-4 border-b border-stone-100 dark:border-stone-800 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-100">People</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-2">
          {members.length === 0 ? (
            <p className="text-sm text-stone-500 text-center py-8">No one is here yet.</p>
          ) : (
            members.map((member) => {
              const isSelf = member.uid === currentUid;
              return (
                <div key={member.uid} className="flex items-center gap-3 p-3 rounded-xl border border-stone-100 dark:border-stone-800">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${member.online ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-stone-600'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-stone-800 dark:text-stone-100 truncate">
                      {member.name}
                      {isSelf ? ' (you)' : ''}
                    </p>
                    <p className="text-xs text-stone-500">
                      {member.isOwner ? 'Owner' : member.isAdmin ? 'Admin' : 'Member'}
                      {member.online ? '' : ' · offline'}
                    </p>
                  </div>
                  {isAdmin && !isSelf && !member.isOwner ? (
                    <div className="flex items-center gap-1 shrink-0">
                      {member.isAdmin ? (
                        <button
                          type="button"
                          onClick={() => onRevokeAdmin(member.uid)}
                          className="p-2 rounded-lg text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                          title="Remove admin"
                        >
                          <ShieldOff className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onGrantAdmin(member.uid)}
                          className="p-2 rounded-lg text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                          title="Make admin"
                        >
                          <Shield className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onBan(member)}
                        className="p-2 rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                        title="Ban user"
                      >
                        <UserX className="w-4 h-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}

          {isAdmin && banned.length > 0 ? (
            <div className="pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2">Banned</h3>
              <div className="space-y-2">
                {banned.map((row) => (
                  <div key={row.uid} className="flex items-center gap-3 p-3 rounded-xl border border-rose-100 dark:border-rose-900/40 bg-rose-50/50 dark:bg-rose-950/20">
                    <Ban className="w-4 h-4 text-rose-500 shrink-0" />
                    <p className="flex-1 min-w-0 font-medium text-stone-800 dark:text-stone-100 truncate">{row.name}</p>
                    <button
                      type="button"
                      onClick={() => onUnban(row.uid)}
                      className="text-sm text-indigo-600 dark:text-indigo-400 font-medium px-2 py-1"
                    >
                      Unban
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
