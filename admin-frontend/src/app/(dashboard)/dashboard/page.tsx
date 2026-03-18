'use client';

import { useAuthStore } from '@/store/authStore';

export default function DashboardPage() {
  const { user } = useAuthStore();

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100">
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          Welcome back, {user?.name}!
        </h3>
        <p className="text-gray-500">
          You are logged in as <span className="font-semibold text-blue-600 capitalize">{user?.role?.replace('_', ' ')}</span>.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Quick Stats Placeholder */}
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100">
          <h4 className="text-sm font-medium text-gray-500 mb-1">Total Users</h4>
          <p className="text-3xl font-bold text-gray-900">--</p>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100">
          <h4 className="text-sm font-medium text-gray-500 mb-1">Active Sessions</h4>
          <p className="text-3xl font-bold text-gray-900">--</p>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100">
          <h4 className="text-sm font-medium text-gray-500 mb-1">System Status</h4>
          <p className="text-3xl font-bold text-green-500">Healthy</p>
        </div>
      </div>
    </div>
  );
}
