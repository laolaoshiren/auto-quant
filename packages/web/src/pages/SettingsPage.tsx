/**
 * Legacy `/settings` entry point.
 *
 * The three sections that used to live behind tabs here are now first-class
 * sidebar items, so old bookmarks and external links are forwarded to the model
 * page rather than dead-ending on a 404.
 */
import { Navigate } from 'react-router-dom';

export function SettingsPage() {
  return <Navigate to="/models" replace />;
}
