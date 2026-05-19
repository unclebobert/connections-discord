import { useEffect, useState } from 'react'
import './App.css'

interface GameCategory {
  title: string;
  cards: Array<{
    content: string;
    position: number;
  }>
}

interface GameData {
  status: string;
  id: number;
  print_date: string;
  editor: string;
  categories: GameCategory[];
}

function App() {
  const [data, setData] = useState<GameData | null>(null)
  useEffect(() => {
    const today = new Date()
    const dateFormatted = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`
    fetch(`https://www.nytimes.com/svc/connections/v2/${dateFormatted}.json`)
      .then(response => response.json())
      .then(data => setData(data))
      .catch(error => console.error('Error fetching data:', error))
  }, [])

  return (
    <>
    </>
  )
}

export default App
