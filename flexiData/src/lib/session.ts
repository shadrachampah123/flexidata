import { redirect } from "next/navigation";
import { getCurrentUser, type AuthUser } from "@/lib/auth";
import { getWalletRowForUser, toWalletDTO, type WalletDTO } from "@/lib/data";

/**
 * For Server Components: require a signed-in user (middleware already gates
 * the route, this is the in-component data lookup + redirect safety net) and
 * return their wallet DTO.
 */
export async function requireSession(): Promise<{ user: AuthUser; wallet: WalletDTO }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const walletRow = await getWalletRowForUser(user.id);
  return { user, wallet: toWalletDTO(walletRow, user.email) };
}
