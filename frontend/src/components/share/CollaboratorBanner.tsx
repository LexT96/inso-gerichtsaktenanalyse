interface Props {
  ownerName: string;
}

export function CollaboratorBanner({ ownerName }: Props) {
  return (
    <div className="bg-blue-50 border border-blue-200 text-blue-900 text-sm px-4 py-2 rounded-lg mb-3">
      <span className="font-medium">Co-Bearbeitung</span> — Eigentümer: {ownerName}
    </div>
  );
}
